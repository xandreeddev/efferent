import { Effect } from "effect"
import { closeIssueEntity } from "../domain/issue.entity.functions.js"
import type { IssueNotFound } from "../domain/issue.entity.js"
import { IssueRepository } from "../ports/issue-repository.port.js"
import { IssueClock } from "../ports/runtime-values.port.js"
import type { CloseIssueInput, CloseIssueOutput } from "./close-issue.usecase.js"

export const closeIssue = (
  input: CloseIssueInput,
): Effect.Effect<CloseIssueOutput, IssueNotFound, IssueRepository | IssueClock> =>
  Effect.gen(function* () {
    const repository = yield* IssueRepository
    const clock = yield* IssueClock
    const issue = yield* repository.get(input.issueId)
    const now = yield* clock.now
    const closed = yield* closeIssueEntity(issue, now)
    yield* repository.save(closed)
    return closed
  })
