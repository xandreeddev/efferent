import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { LanguageModel } from "@effect/ai"
import {
  ApprovalAllowAllLive,
  ContextTreeStore,
  ConversationStore,
  FileSystem,
  Http,
  SettingsStore,
  Shell,
  TerminalSession,
  UtilityLlm,
  WebSearch,
} from "@xandreed/sdk-core"
import type { ConversationId, DirEntry } from "@xandreed/sdk-core"
import type { SmithEvent } from "../domain/SmithEvent.js"
import { makeRefineSession } from "./session.js"
import type { RefineAgent } from "./session.js"

const CWD = "/ws"

/** In-memory FileSystem (write/read/list) — the spec file is the truth. */
const memoryFs = () => {
  const files = new Map<string, string>()
  const layer = Layer.succeed(
    FileSystem,
    FileSystem.of({
      read: (path: string) =>
        files.has(path)
          ? Effect.succeed({ content: files.get(path) ?? "", truncated: false, totalLines: 1 })
          : Effect.fail({ _tag: "FileNotFound", path } as never),
      write: (path: string, content: string) =>
        Effect.sync(() => {
          files.set(path, content)
        }),
      exists: (path: string) => Effect.succeed(files.has(path)),
      list: (dir: string) =>
        Effect.succeed(
          [...files.keys()]
            .filter((path) => path.startsWith(`${dir}/`))
            .map((path): DirEntry => ({ path, type: "file" })),
        ),
      glob: () => Effect.succeed([]),
    } as never),
  )
  return { files, layer }
}

/** Everything the session's context capture wants; the scripted agent touches
 *  none of it beyond FileSystem + the conversation mint. */
const stubServices = Layer.mergeAll(
  Layer.succeed(Shell, Shell.of({} as never)),
  Layer.succeed(Http, Http.of({} as never)),
  Layer.succeed(WebSearch, WebSearch.of({} as never)),
  Layer.succeed(TerminalSession, TerminalSession.of({} as never)),
  Layer.succeed(ContextTreeStore, ContextTreeStore.of({} as never)),
  Layer.succeed(UtilityLlm, UtilityLlm.of({} as never)),
  Layer.succeed(LanguageModel.LanguageModel, {} as never),
  Layer.succeed(
    ConversationStore,
    ConversationStore.of({
      create: () => Effect.succeed("refine-conv-1" as ConversationId),
    } as never),
  ),
  ApprovalAllowAllLive,
  // Part of the captured context; the scripted path never reads it.
  Layer.succeed(SettingsStore, {} as never),
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
