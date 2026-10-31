import { Schema } from "effect"

/** Native process outcomes; a forced exit can truncate an output frame. @public */
export const PROCESS_EXIT_CODES = {
  clean: 0,
  failure: 1,
  protocol: 2,
  hardDeadline: 124,
  SIGINT: 130,
  SIGTERM: 143,
} as const

export const ProcessRuntimeConfig = Schema.Struct({
  hardDeadlineMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })),
})
