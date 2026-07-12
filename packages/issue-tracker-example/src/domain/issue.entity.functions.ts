import { Effect, Option } from "effect"
import type { Issue, IssueClosed, IssueId, MemberId, NewIssue } from "./issue.entity.js"
import type { InvalidIssue } from "./issue.entity.js"

export const createIssueEntity = (
  id: IssueId,
  input: NewIssue,
  now: string,
): Effect.Effect<Issue, InvalidIssue> =>
  input.title.trim().length === 0
    ? Effect.fail({ _tag: "InvalidIssue", reason: "title must not be blank" })
    : Effect.succeed({
        id,
        title: input.title.trim(),
        description: input.description.trim(),
        status: "open",
        assigneeId: Option.none(),
        createdAt: now,
        updatedAt: now,
      })

export const assignIssueEntity = (
  issue: Issue,
  memberId: MemberId,
  now: string,
): Effect.Effect<Issue, IssueClosed> =>
  issue.status === "closed"
    ? Effect.fail({ _tag: "IssueClosed", issueId: issue.id })
    : Effect.succeed({
        ...issue,
        status: "assigned",
        assigneeId: Option.some(memberId),
        updatedAt: now,
      })

export const closeIssueEntity = (
  issue: Issue,
  now: string,
): Effect.Effect<Issue> =>
  Effect.succeed({ ...issue, status: "closed", updatedAt: now })
