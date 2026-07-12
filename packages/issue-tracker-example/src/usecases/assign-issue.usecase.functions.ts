import { Effect } from "effect"
import { assignIssueEntity } from "../domain/issue.entity.functions.js"
import type { IssueClosed, IssueNotFound } from "../domain/issue.entity.js"
import type { MemberNotFound } from "../domain/member.entity.js"
import { IssueRepository } from "../ports/issue-repository.port.js"
import { MemberDirectory } from "../ports/member-directory.port.js"
import { NotificationPublisher } from "../ports/notification-publisher.port.js"
import { IssueClock } from "../ports/runtime-values.port.js"
import type { AssignIssueInput, AssignIssueOutput } from "./assign-issue.usecase.js"

export const assignIssue = (
  input: AssignIssueInput,
): Effect.Effect<
  AssignIssueOutput,
  IssueNotFound | MemberNotFound | IssueClosed,
  IssueRepository | MemberDirectory | NotificationPublisher | IssueClock
> =>
  Effect.gen(function* () {
    const repository = yield* IssueRepository
    const members = yield* MemberDirectory
    const notifications = yield* NotificationPublisher
    const clock = yield* IssueClock
    const { issue, member, now } = yield* Effect.all(
      {
        issue: repository.get(input.issueId),
        member: members.get(input.memberId),
        now: clock.now,
      },
      { concurrency: 3 },
    )
    const assigned = yield* assignIssueEntity(issue, member.id, now)
    yield* repository.save(assigned)
    yield* notifications.issueAssigned(assigned, member)
    return assigned
  })
