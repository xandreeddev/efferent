import { Context, Effect } from "effect"

export interface ConstraintFeedback {
  readonly notedAt: number
  readonly timesSeen: number
  readonly timesHelped: number
  readonly lastHelpedAt?: number
}

export interface CounterFeedbackApi {
  /** Record that a constraint was just distilled/persisted. */
  readonly recordConstraintNoted: (name: string) => Effect.Effect<void>
  /** Record that a constraint was useful (prevented a mistake). */
  readonly recordConstraintHelped: (name: string) => Effect.Effect<void>
  /** Read current feedback for a constraint name. */
  readonly getFeedback: (name: string) => Effect.Effect<ConstraintFeedback | undefined>
}

export class CounterFeedback extends Context.Tag("@xandreed/sdk-core/CounterFeedback")<
  CounterFeedback,
  CounterFeedbackApi
>() {}
