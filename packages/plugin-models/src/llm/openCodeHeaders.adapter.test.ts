import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { ConversationId, CurrentPromptCacheKey, makeTurnEvents, makeTurnTasks, RunContext, UserMessage } from "@xandreed/core"
import { makeOpenCodeRequestHeaders } from "./openCodeHeaders.adapter.js"

test("OpenCode routing uses the native current session before cache identity and keeps standalone fallbacks stable", async () => {
  const outcome = await Effect.runPromise(Effect.gen(function* () {
    const headers = yield* makeOpenCodeRequestHeaders
    const separate = yield* makeOpenCodeRequestHeaders
    const events = yield* makeTurnEvents({ maxDepth: 8 })
    const tasks = yield* makeTurnTasks(yield* Effect.scope)
    const context = (id: string) => RunContext.of({
      conversation: ConversationId.make(id), session: { id: ConversationId.make(id), owner: "fixture" }, runId: "fixture", userMessage: new UserMessage({ text: "hello" }),
      memory: { turn: Effect.succeed(1), entries: Effect.succeed([]), query: () => Effect.succeed([]), subjects: () => Effect.succeed([]), resolve: () => Effect.succeedNone, transcript: () => Effect.succeed([]) },
      events, tasks, activate: () => Effect.succeed([]), flush: Effect.void, write: (effect) => effect,
    })
    return {
      first: yield* headers, retry: yield* headers, separate: yield* separate,
      auxiliary: yield* headers.pipe(Effect.provideService(CurrentPromptCacheKey, Option.some("auxiliary-conversation"))),
      parent: yield* headers.pipe(Effect.provideService(RunContext, context("00000000-0000-4000-8000-000000000072")), Effect.provideService(CurrentPromptCacheKey, Option.some("cache-parent"))),
      editor: yield* headers.pipe(Effect.provideService(RunContext, context("00000000-0000-4000-8000-000000000073")), Effect.provideService(CurrentPromptCacheKey, Option.some("cache-parent"))),
    }
  }).pipe(Effect.scoped))
  expect(outcome.first["x-opencode-session"]).toBe(outcome.retry["x-opencode-session"])
  expect(outcome.separate["x-opencode-session"]).not.toBe(outcome.first["x-opencode-session"])
  expect(outcome.auxiliary["x-opencode-session"]).toBe("auxiliary-conversation")
  expect(outcome.parent["x-opencode-session"]).toBe("00000000-0000-4000-8000-000000000072")
  expect(outcome.editor["x-opencode-session"]).toBe("00000000-0000-4000-8000-000000000073")
  expect(outcome.editor["user-agent"]).toBe("efferent/0.8.0-next.0")
})
