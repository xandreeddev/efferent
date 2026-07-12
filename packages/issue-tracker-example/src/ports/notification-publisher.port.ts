import { Context, Effect } from "effect"
import type { Issue } from "../domain/issue.entity.js"
import type { Member } from "../domain/member.entity.js"

export class NotificationPublisher extends Context.Tag("IssueTracker/NotificationPublisher")<
  NotificationPublisher,
  {
    readonly issueAssigned: (issue: Issue, member: Member) => Effect.Effect<void>
  }
>() {}
