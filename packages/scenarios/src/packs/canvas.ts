import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LanguageModel } from "@effect/ai"
import { Context, Effect, Layer, Ref, Stream } from "effect"
import { ConversationStore } from "@xandreed/engine"
import type { AgentMessage } from "@xandreed/engine"
import { SqliteConversationStoreLive } from "@xandreed/providers"
import { makeCanvasSession } from "@xandreed/canvas"
import type { CanvasEvent, CanvasSession } from "@xandreed/canvas"
import type { Pack } from "../framework/model.js"
import { scenario } from "../framework/run.js"
import { eventWhere, toolSequence, turnAlternationValid } from "../framework/evidence.js"

/**
 * The canvas pack: the ENFORCED render loop as a scenario — a page that
 * violates the UI gates bounces with the findings as data, the model fixes
 * exactly what the gate named, and the corrected render is the only one the
 * user ever sees. The scripted twin drives the REAL session chassis +
 * `render_ui` chokepoint + surface gates + SQLite trail; only the model is
 * scripted (key-free in CI). The gates themselves are unit-tested in
 * packages/surface; this pack owns the agent-harness slice (bounce →
 * corrective re-render → accepted event → persisted trail).
 */

const VIOLATING_HTML = `<div class="cv-page">
  <header class="cv-hero"><h1>Board</h1><p>Status at a glance.</p></header>
  <section class="cv-card bg-red-500">
    <h2>Alerts</h2>
    <div hx-get="/action/ui" hx-trigger="load"></div>
  </section>
</div>`

const CLEAN_HTML = `<div class="cv-page">
  <header class="cv-hero"><h1>Board</h1><p>Status at a glance.</p></header>
  <section class="cv-card">
    <h2>Alerts</h2>
    <span class="cv-badge cv-badge--ok">all clear</span>
  </section>
</div>`

const finish = (reason: string) => ({
  type: "finish",
  reason,
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
})

const renderCall = (id: string, callId: string, html: string) => ({
  type: "tool-call",
  id: callId,
  name: "render_ui",
  params: { id, title: "Board", html },
})

/** Call 0: a render that violates TWO gates (a palette colour + a
 *  self-firing trigger) — must bounce with both findings. Call 1: the model
 *  "reads" the findings and re-sends the same page id fixed. Call 2: the
 *  one-sentence caption. */
const scriptedBuilder = (calls: Ref.Ref<number>) =>
  LanguageModel.make({
    generateText: () =>
      Ref.getAndUpdate(calls, (n) => n + 1).pipe(
        Effect.map(
          (call) =>
            (call === 0
              ? [renderCall("board", "c1", VIOLATING_HTML), finish("tool-calls")]
              : call === 1
                ? [renderCall("board", "c2", CLEAN_HTML), finish("tool-calls")]
                : [{ type: "text", text: "Built the board page." }, finish("stop")]) as never,
        ),
      ),
    streamText: () => Stream.die("not scripted") as never,
  })

interface CanvasWorld {
  readonly events: () => ReadonlyArray<CanvasEvent>
  readonly session: CanvasSession
  readonly messages: Effect.Effect<ReadonlyArray<AgentMessage>>
}

const bootCanvasWorld = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "scenario-canvas-"))
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )
  const calls = yield* Ref.make(0)
  const services = yield* Layer.build(
    Layer.mergeAll(
      SqliteConversationStoreLive(join(dir, ".efferent", "canvas.db")),
      Layer.effect(LanguageModel.LanguageModel, scriptedBuilder(calls)),
    ),
  )
  const store = Context.get(services, ConversationStore)
  const cid = yield* store.create(dir).pipe(Effect.orDie)
  const session = yield* makeCanvasSession({ conversationId: cid }).pipe(
    Effect.provide(services),
  )
  return {
    events: () => Effect.runSync(session.state).log.map((s) => s.event),
    session,
    messages: store.list(cid).pipe(Effect.orDie),
  } satisfies CanvasWorld
})

/* ---- evidence helpers over the canvas trail -------------------------- */

const renderedPages = (
  events: ReadonlyArray<CanvasEvent>,
): ReadonlyArray<{ readonly id: string; readonly html: string }> =>
  events.flatMap((e) => (e.type === "ui_render" ? [{ id: e.entry.id, html: e.entry.html }] : []))

const bounceMessages = (events: ReadonlyArray<CanvasEvent>): ReadonlyArray<string> =>
  events.flatMap((e) => {
    if (e.type !== "tool_end" || e.toolName !== "render_ui") return []
    const raw = JSON.stringify(e.result ?? {})
    return raw.includes("UiRejected") ? [raw] : []
  })

export const canvasPack: Pack = {
  name: "canvas",
  threshold: 0.95,
  scenarios: [
    scenario<CanvasWorld>({
      name: "render_ui gate bounce → corrective re-render (scripted twin)",
      modes: ["scripted"],
      boot: bootCanvasWorld,
      steps: [
        {
          name: "one ask: the violating render bounces, the fixed one lands",
          act: (w) => w.session.send("make me a status board"),
          checks: [
            eventWhere<CanvasEvent>(
              "exactly ONE ui_render reached the canvas — the corrected page",
              (events) => {
                const pages = renderedPages(events)
                return (
                  pages.length === 1 &&
                  pages[0]?.id === "board" &&
                  !pages[0].html.includes("bg-red-500") &&
                  !pages[0].html.includes("hx-trigger")
                )
              },
            ),
            eventWhere<CanvasEvent>(
              "the bounce named BOTH violations (colour utility + self-firing trigger)",
              (events) => {
                const bounces = bounceMessages(events)
                return (
                  bounces.length === 1 &&
                  bounces[0]!.includes("no-color-utilities") &&
                  bounces[0]!.includes("no-self-trigger")
                )
              },
            ),
          ],
        },
        {
          name: "the persisted conversation is the audit trail",
          act: () => Effect.void,
          checks: [
            turnAlternationValid<CanvasWorld>((w) => w.messages),
            toolSequence<CanvasWorld>((w) => w.messages, ["render_ui", "render_ui"], "exact"),
          ],
        },
      ],
    }),
  ],
}
