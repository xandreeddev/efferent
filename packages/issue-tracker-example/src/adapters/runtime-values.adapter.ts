import { Effect, Layer, Ref } from "effect"
import { IssueId } from "../domain/issue.entity.js"
import { IssueClock, IssueIdGenerator } from "../ports/runtime-values.port.js"

export const FixedIssueClockLive = (now: string): Layer.Layer<IssueClock> =>
  Layer.succeed(IssueClock, { now: Effect.succeed(now) })

export const SequenceIssueIdLive = Layer.effect(
  IssueIdGenerator,
  Effect.map(Ref.make(0), (counter) => ({
    next: Ref.getAndUpdate(counter, (current) => current + 1).pipe(
      Effect.map((current) => IssueId.make(`ISSUE-${current + 1}`)),
    ),
  })),
)
