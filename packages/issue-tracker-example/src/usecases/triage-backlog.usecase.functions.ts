import { Effect } from "effect"
import { assignIssueEntity } from "../domain/issue.entity.functions.js"
import type { IssueClosed } from "../domain/issue.entity.js"
import type { NoAvailableMember } from "../domain/member.entity.js"
import { IssueRepository } from "../ports/issue-repository.port.js"
import { MemberDirectory } from "../ports/member-directory.port.js"
import { NotificationPublisher } from "../ports/notification-publisher.port.js"
import { IssueClock } from "../ports/runtime-values.port.js"
import type { TriageBacklogInput, TriageBacklogOutput } from "./triage-backlog.usecase.js"

export const triageBacklog = (
  input: TriageBacklogInput,
): Effect.Effect<
  TriageBacklogOutput,
  NoAvailableMember | IssueClosed,
  IssueRepository | MemberDirectory | NotificationPublisher | IssueClock
> =>
  Effect.gen(function* () {
    const repository = yield* IssueRepository
    const members = yield* MemberDirectory
    const notifications = yield* NotificationPublisher
    const clock = yield* IssueClock
    const open = yield* repository.listOpen
    return yield* Effect.forEach(
      open,
      (issue) =>
        Effect.gen(function* () {
          const [member, now] = yield* Effect.all([members.recommend(issue), clock.now], {
            concurrency: 2,
          })
          const assigned = yield* assignIssueEntity(issue, member.id, now)
          yield* repository.save(assigned)
          yield* notifications.issueAssigned(assigned, member)
          return assigned
        }),
      { concurrency: input.concurrency },
    )
  })
