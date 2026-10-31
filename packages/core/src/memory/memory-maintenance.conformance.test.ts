import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { HarnessError } from "../harness/plugin.entity.js"
import { ConversationMemory } from "../ports/memory.port.js"
import { memoryConformance } from "./memory.conformance.js"
import { openLogSession } from "./memory-session.js"
import type { MemoryPolicy } from "./memory-session.js"

const policy: MemoryPolicy = { strategy: { id: "unchanged", version: "1" }, render: { turnContext: "current", replies: true, digests: true, media: { mode: "inline", maxImages: 8, maxChars: 20_000_000 } }, digestOnWrite: Option.none(), maintain: () => Effect.succeed({ actions: [], digest: [] }) }
const checkOf = (careless: boolean) => memoryConformance(ConversationMemory.of({ strategy: policy.strategy, open: ({ log, runId }) => openLogSession(log, policy, { runId }).pipe(Effect.map(session => ({ ...session,
  maintain: signal => careless && (signal.phase === "turn-end" || signal.phase === "overflow")
    ? Effect.fail(new HarnessError({ code: "memory.log", message: "unrecognized phase" })) : session.maintain(signal),
}))) })).find(check => check.name.startsWith("turn-end and overflow"))!

test("the new memory phase check accepts a no-op policy and rejects an old-phase-only adapter", async () => {
  expect((await Effect.runPromise(Effect.result(checkOf(false).run)))._tag).toBe("Success")
  const failed = await Effect.runPromise(Effect.result(checkOf(true).run))
  expect(failed._tag === "Failure" && failed.failure.check).toBe("maintenance-phases")
})
