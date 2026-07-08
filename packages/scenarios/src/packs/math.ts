import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LanguageModel } from "@effect/ai"
import { Context, Effect, Layer, Ref, Stream } from "effect"
import { ConversationStore } from "@xandreed/engine"
import type { AgentMessage } from "@xandreed/engine"
import { SqliteConversationStoreLive } from "@xandreed/providers"
import { composeAgentMessage, makeMathSession } from "@xandreed/math"
import type { MathSession, MathSessionEvent } from "@xandreed/math"
import type { Pack } from "../framework/model.js"
import { scenario } from "../framework/run.js"
import { briefContains, eventWhere, toolSequence, turnAlternationValid } from "../framework/evidence.js"

/**
 * The math pack: the tutor session's ENFORCED admission story as a scenario —
 * a malformed item bounces as data while the good ones render, and a later
 * batch re-serving an id hits the session-scope dedupe. The scripted twin
 * drives the REAL session chassis + toolkit + admission gate + SQLite trail;
 * only the model is scripted (key-free in CI). Grading is pure and unit-tested
 * in packages/math; this pack owns the agent-harness slice.
 */

const exercise = (id: string): Record<string, unknown> => ({
  kind: "exercise",
  id,
  prompt: `What is 2 + 2? (${id})`,
  answer: { kind: "integer", value: "4" },
  hint: "Count up from 2.",
  solution: [{ text: "2 + 2 = 4" }],
})

const finish = (reason: string) => ({
  type: "finish",
  reason,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
})

/** Call 0: a batch with one malformed key (must bounce, the rest render).
 *  Call 2: a batch re-serving ex-1 (must hit the session dedupe). */
const scriptedTutor = (calls: Ref.Ref<number>) =>
  LanguageModel.make({
    generateText: () =>
      Ref.getAndUpdate(calls, (n) => n + 1).pipe(
        Effect.map(
          (call) =>
            (call === 0
              ? [
                  {
                    type: "tool-call",
                    id: "m1",
                    name: "render_math",
                    params: {
                      items: [
                        exercise("ex-1"),
                        exercise("ex-2"),
                        { ...exercise("ex-3"), answer: { kind: "integer", value: "seven" } },
                      ],
                    },
                  },
                  finish("tool-calls"),
                ]
              : call === 1
                ? [{ type: "text", text: "Two exercises are up." }, finish("stop")]
                : call === 2
                  ? [
                      {
                        type: "tool-call",
                        id: "m2",
                        name: "render_math",
                        params: { items: [exercise("ex-1"), exercise("ex-4")] },
                      },
                      finish("tool-calls"),
                    ]
                  : [{ type: "text", text: "One more added." }, finish("stop")]) as never,
        ),
      ),
    streamText: () => Stream.die("not scripted") as never,
  })

interface MathWorld {
  readonly dir: string
  readonly events: () => ReadonlyArray<MathSessionEvent>
  readonly session: MathSession
  readonly messages: Effect.Effect<ReadonlyArray<AgentMessage>>
}

const bootMathWorld = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "scenario-math-"))
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )
  const calls = yield* Ref.make(0)
  const services = yield* Layer.build(
    Layer.mergeAll(
      SqliteConversationStoreLive(join(dir, ".efferent", "math.db")),
      Layer.effect(LanguageModel.LanguageModel, scriptedTutor(calls)),
    ),
  )
  const store = Context.get(services, ConversationStore)
  const cid = yield* store.create(dir).pipe(Effect.orDie)
  const session = yield* makeMathSession({ conversationId: cid, cwd: dir }).pipe(
    Effect.provide(services),
  )
  return {
    dir,
    events: () => Effect.runSync(session.state).log.map((s) => s.event),
    session,
    messages: store.list(cid).pipe(Effect.orDie),
  } satisfies MathWorld
})

/* ---- evidence helpers over the math trail --------------------------- */

const renderBatches = (events: ReadonlyArray<MathSessionEvent>): ReadonlyArray<ReadonlyArray<string>> =>
  events.flatMap((e) =>
    e.type === "math_render"
      ? [e.items.flatMap((i) => (i.kind === "note" ? [] : [i.id]))]
      : [],
  )

const rejectionReasons = (events: ReadonlyArray<MathSessionEvent>): ReadonlyArray<string> =>
  events.flatMap((e) => {
    if (e.type !== "tool_end" || e.toolName !== "render_math") return []
    const result =
      typeof e.result === "object" && e.result !== null
        ? (e.result as { rejected?: ReadonlyArray<{ reason?: string }> })
        : {}
    return (result.rejected ?? []).flatMap((r) => (r.reason === undefined ? [] : [r.reason]))
  })

export const mathPack: Pack = {
  name: "math",
  threshold: 0.95,
  scenarios: [
    scenario<MathWorld>({
      name: "admission + session dedupe (scripted twin)",
      modes: ["scripted"],
      boot: bootMathWorld,
      steps: [
        {
          name: "the start action serves a batch; the malformed item bounces as data",
          act: (w) => w.session.send(composeAgentMessage([], { kind: "start", grade: 4, theme: "fractions" })),
          checks: [
            eventWhere<MathSessionEvent>("only the valid exercises render (ex-1, ex-2)", (events) => {
              const batches = renderBatches(events)
              return batches.length === 1 && batches[0]?.join(",") === "ex-1,ex-2"
            }),
            eventWhere<MathSessionEvent>("the malformed key bounced with its exact reason", (events) =>
              rejectionReasons(events).some((r) => r.includes("not an integer")),
            ),
          ],
        },
        {
          name: "a later batch re-serving an id hits the session-scope dedupe",
          act: (w) => w.session.send(composeAgentMessage([], { kind: "more" })),
          checks: [
            eventWhere<MathSessionEvent>("the second batch admits only the NEW exercise", (events) => {
              const batches = renderBatches(events)
              return batches.length === 2 && batches[1]?.join(",") === "ex-4"
            }),
            eventWhere<MathSessionEvent>("the re-served id bounced with the dedupe reason", (events) =>
              rejectionReasons(events).some((r) => r.includes("already served this session")),
            ),
          ],
        },
        {
          name: "the persisted conversation is the audit trail",
          act: () => Effect.void,
          checks: [
            turnAlternationValid<MathWorld>((w) => w.messages),
            toolSequence<MathWorld>((w) => w.messages, ["render_math", "render_math"], "exact"),
            briefContains<MathWorld>((w) => w.messages, "[action] start"),
          ],
        },
      ],
    }),
  ],
}
