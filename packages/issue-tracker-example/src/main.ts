import { Layer } from "effect"
import { MemberId } from "./domain/issue.entity.js"
import { FixedIssueClockLive, SequenceIssueIdLive } from "./adapters/runtime-values.adapter.js"
import { InMemoryIssueRepositoryLive } from "./adapters/in-memory-issue-repository.adapter.js"
import { InMemoryNotificationPublisherLive } from "./adapters/in-memory-notification-publisher.adapter.js"
import { StaticMemberDirectoryLive } from "./adapters/static-member-directory.adapter.js"

export const IssueTrackerLive = Layer.mergeAll(
  InMemoryIssueRepositoryLive,
  InMemoryNotificationPublisherLive,
  SequenceIssueIdLive,
  FixedIssueClockLive(new Date(0).toISOString()),
  StaticMemberDirectoryLive([
    { id: MemberId.make("member-1"), name: "Reference Maintainer", active: true },
  ]),
)
