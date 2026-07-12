import { Context, Effect } from "effect"
import type { Issue, IssueId, IssueNotFound } from "../domain/issue.entity.js"

export class IssueRepository extends Context.Tag("IssueTracker/IssueRepository")<
  IssueRepository,
  {
    readonly get: (id: IssueId) => Effect.Effect<Issue, IssueNotFound>
    readonly save: (issue: Issue) => Effect.Effect<void>
    readonly listOpen: Effect.Effect<ReadonlyArray<Issue>>
  }
>() {}
