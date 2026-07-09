import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { LanguageModel } from "@effect/ai"
import { ConversationStore, FileSystem, Shell } from "@xandreed/engine"
import { ConversationId } from "@xandreed/engine"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { makeRefineSession } from "./session.js"
import type { RefineAgent } from "./session.js"

const CWD = "/ws"

/** In-memory FileSystem (write/read/list) — the spec file is the truth. */
const memoryFs = () => {
  const files = new Map<string, string>()
  const layer = Layer.succeed(FileSystem, {
    read: (path: string) =>
      files.has(path)
        ? Effect.succeed(files.get(path) ?? "")
        : Effect.fail({ _tag: "FsError", path, message: "not found" } as never),
    write: (path: string, content: string) =>
      Effect.sync(() => {
        files.set(path, content)
      }),
    exists: (path: string) => Effect.succeed(files.has(path)),
    list: (dir: string) =>
      Effect.succeed(
        [...files.keys()]
          .filter((path) => path.startsWith(`${dir}/`))
          .map((path) => path.slice(dir.length + 1)),
      ),
    mkdir: () => Effect.void,
  } as never)
  return { files, layer }
}

/** Everything the session's context capture wants; the scripted agent touches
 *  none of it beyond FileSystem + the conversation mint. */
const stubServices = Layer.mergeAll(
  Layer.succeed(Shell, {} as never),
  Layer.succeed(LanguageModel.LanguageModel, {} as never),
  Layer.succeed(ConversationStore, {
    create: () =>
      Effect.succeed(ConversationId.make("00000000-0000-4000-8000-00000000abcd")),
  } as never),
)

/** The scripted refiner: one propose through the SESSION's own handlers —
 *  the same slug identity and draft tracking the real agent gets. */
const scriptedAgent: RefineAgent = (_cid, prompt, tools) =>
  tools
    .propose({
      goal: `Refined: ${prompt}`,
      acceptance: ["it works"],
      constraints: undefined,
      nonGoals: undefined,
      checks: [{ name: "smoke", command: "true" }],
      maxAttempts: undefined,
      budgetMinutes: undefined,
    })
    .pipe(Effect.asVoid, Effect.orDie)

describe("makeRefineSession — scripted E2E (no keys, no LLM)", () => {
  test("send → draft file + spec_draft event; lock → spec_locked + locked file", async () => {
    const fs = memoryFs()
    const events: SmithEvent[] = []
    const publish = (event: SmithEvent) =>
      Effect.sync(() => {
        events.push(event)
      })

    const { draft, locked } = await Effect.gen(function* () {
      const session = yield* makeRefineSession(CWD, publish, {
        unattended: true,
        agent: scriptedAgent,
      })
      const draft = yield* session.send("build a widget")
      const locked = yield* session.lock
      return { draft, locked }
    }).pipe(Effect.provide(Layer.mergeAll(fs.layer, stubServices)), Effect.runPromise)

    // The draft round-tripped from the FILE the handler wrote.
    expect(Option.isSome(draft)).toBe(true)
    if (Option.isNone(draft)) return
    expect(draft.value.doc.goal).toBe("Refined: build a widget")
    expect(draft.value.doc.status).toBe("draft")
    expect(draft.value.doc.checks[0]?.name).toBe("smoke")

    // Locking rewrote it in place.
    expect(locked.doc.status).toBe("locked")
    expect(Option.isSome(locked.doc.locked)).toBe(true)
    expect(fs.files.get(locked.path)).toContain("status: locked")

    // Event sequence: the draft, then the lock.
    expect(events.map((event) => event.type)).toEqual(["spec_draft", "spec_locked"])
  })

  test("RESUME recovers the draft from the TRAIL — lock works without a new propose", async () => {
    // The deadlock class: a session resumed after propose_spec had no
    // in-memory draftRef → ":lock" refused while the spec sat on disk and
    // the model (which remembers proposing) would not re-propose.
    const fs = memoryFs()
    const cid = ConversationId.make("00000000-0000-4000-8000-00000000dead")
    const storeWithTrail = Layer.succeed(ConversationStore, {
      create: () => Effect.succeed(cid),
      list: () =>
        Effect.succeed([
          { role: "user", content: "build a widget" },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "p1",
                toolName: "propose_spec",
                isError: false,
                output: {
                  slug: "refined-build-a-widget",
                  path: `${CWD}/.efferent/specs/refined-build-a-widget.md`,
                  status: "draft",
                },
              },
            ],
          },
        ]),
    } as never)
    const services = Layer.mergeAll(
      Layer.succeed(Shell, {} as never),
      Layer.succeed(LanguageModel.LanguageModel, {} as never),
      storeWithTrail,
    )

    const { first, locked } = await Effect.gen(function* () {
      // Seed the workspace: the spec FILE the original session wrote.
      const original = yield* makeRefineSession(CWD, () => Effect.void, {
        unattended: true,
        agent: scriptedAgent,
      })
      yield* original.send("build a widget")
      // A fresh session RESUMING the conversation — no propose this time.
      const resumed = yield* makeRefineSession(CWD, () => Effect.void, {
        unattended: true,
        agent: scriptedAgent,
        resume: cid,
      })
      const first = yield* resumed.currentDraft
      const locked = yield* resumed.lock
      return { first, locked }
    }).pipe(Effect.provide(Layer.mergeAll(fs.layer, services)), Effect.runPromise)

    expect(Option.isSome(first)).toBe(true)
    if (Option.isNone(first)) return
    expect(first.value.doc.goal).toBe("Refined: build a widget")
    expect(locked.doc.status).toBe("locked")
  })

  test("locking with no draft is a typed refusal", async () => {
    const fs = memoryFs()
    const result = await Effect.gen(function* () {
      const session = yield* makeRefineSession(CWD, () => Effect.void, {
        unattended: true,
        agent: scriptedAgent,
      })
      return yield* Effect.either(session.lock)
    }).pipe(Effect.provide(Layer.mergeAll(fs.layer, stubServices)), Effect.runPromise)
    expect(result._tag).toBe("Left")
    if (result._tag !== "Left") return
    expect(result.left.message).toContain("nothing to lock")
  })
})
