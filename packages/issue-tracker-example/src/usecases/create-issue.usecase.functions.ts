import { Effect } from "effect"
import { createIssueEntity } from "../domain/issue.entity.functions.js"
import type { InvalidIssue } from "../domain/issue.entity.js"
import { IssueRepository } from "../ports/issue-repository.port.js"
import { IssueClock, IssueIdGenerator } from "../ports/runtime-values.port.js"
import type { CreateIssueInput, CreateIssueOutput } from "./create-issue.usecase.js"

export const createIssue = (
  input: CreateIssueInput,
): Effect.Effect<CreateIssueOutput, InvalidIssue, IssueRepository | IssueClock | IssueIdGenerator> =>
  Effect.gen(function* () {
    const repository = yield* IssueRepository
    const clock = yield* IssueClock
    const ids = yield* IssueIdGenerator
    const [id, now] = yield* Effect.all([ids.next, clock.now], { concurrency: 2 })
    const issue = yield* createIssueEntity(id, input, now)
    yield* repository.save(issue)
    return issue
  })
