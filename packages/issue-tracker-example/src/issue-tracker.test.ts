import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option } from "effect"
import { MemberId } from "./domain/issue.entity.js"
import { InMemoryIssueRepositoryLive } from "./adapters/in-memory-issue-repository.adapter.js"
import { InMemoryNotificationPublisherLive } from "./adapters/in-memory-notification-publisher.adapter.js"
import { FixedIssueClockLive, SequenceIssueIdLive } from "./adapters/runtime-values.adapter.js"
import { StaticMemberDirectoryLive } from "./adapters/static-member-directory.adapter.js"
import { assignIssue } from "./usecases/assign-issue.usecase.functions.js"
import { createIssue } from "./usecases/create-issue.usecase.functions.js"
import { closeIssue } from "./usecases/close-issue.usecase.functions.js"
import { triageBacklog } from "./usecases/triage-backlog.usecase.functions.js"

const alice = { id: MemberId.make("alice"), name: "Alice", active: true }

const TestLive = Layer.mergeAll(
  InMemoryIssueRepositoryLive,
  InMemoryNotificationPublisherLive,
  SequenceIssueIdLive,
  FixedIssueClockLive("2026-07-12T00:00:00.000Z"),
  StaticMemberDirectoryLive([alice]),
)

describe("issue tracker reference package", () => {
  test("create → concurrently load assignment inputs → close", async () => {
    const program = Effect.gen(function* () {
      const created = yield* createIssue({ title: "  Broken profile lock  ", description: "Fix it" })
      const assigned = yield* assignIssue({ issueId: created.id, memberId: alice.id })
      const closed = yield* closeIssue({ issueId: created.id })
      return { created, assigned, closed }
    }).pipe(Effect.provide(TestLive))

    const result = await Effect.runPromise(program)
    expect(result.created.title).toBe("Broken profile lock")
    expect(Option.getOrThrow(result.assigned.assigneeId)).toBe(alice.id)
    expect(result.closed.status).toBe("closed")
  })

  test("backlog triage uses bounded native Effect concurrency", async () => {
    const program = Effect.gen(function* () {
      yield* createIssue({ title: "one", description: "" })
      yield* createIssue({ title: "two", description: "" })
      return yield* triageBacklog({ concurrency: 2 })
    }).pipe(Effect.provide(TestLive))

    const triaged = await Effect.runPromise(program)
    expect(triaged).toHaveLength(2)
    expect(triaged.every((issue) => issue.status === "assigned")).toBe(true)
  })
})
