import { Effect, Layer, Option, Ref } from "effect"
import type { Issue, IssueId } from "../domain/issue.entity.js"
import { IssueRepository } from "../ports/issue-repository.port.js"

export const InMemoryIssueRepositoryLive = Layer.effect(
  IssueRepository,
  Effect.map(Ref.make(new Map<IssueId, Issue>() as ReadonlyMap<IssueId, Issue>), (state) => ({
    get: (id: IssueId) =>
      Ref.get(state).pipe(
        Effect.flatMap((issues) =>
          Option.match(Option.fromNullable(issues.get(id)), {
            onNone: () => Effect.fail({ _tag: "IssueNotFound" as const, issueId: id }),
            onSome: Effect.succeed,
          }),
        ),
      ),
    save: (issue: Issue) =>
      Ref.update(state, (issues) => new Map(issues).set(issue.id, issue)),
    listOpen: Ref.get(state).pipe(
      Effect.map((issues) => [...issues.values()].filter((issue) => issue.status === "open")),
    ),
  })),
)
