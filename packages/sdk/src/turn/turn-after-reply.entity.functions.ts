import { Cause } from "effect"
import { isHarnessError, isTurnError } from "@xandreed/core"

/** The writer's own failures: the store's, contention, a refused kind and a close. */
const WRITER_TAGS: ReadonlySet<string> = new Set(["TurnClosed", "SessionLogError", "SessionContended", "ReservedKind"])

/** Whether a failure is the writer's: one of its tags, or a `HarnessError` of its own state or a write that died (`session.*`). */
const isWriterFailure = (error: unknown): boolean =>
  isTurnError(error) && (isHarnessError(error) ? error.code.startsWith("session.") : WRITER_TAGS.has(error._tag))

/**
 * Whether what stopped the work after a reply is the writer's (a store
 * failure, a fence, a close), failed or carried as a defect: that stays hard.
 * Anything else, an ordinary failure, a defect or an interruption, is logged
 * and skipped: the reply is sealed, and the next run's start maintains what
 * the work left.
 */
export const isWriterCause = (cause: Cause.Cause<unknown>): boolean => cause.reasons.some((reason) =>
  Cause.isFailReason(reason) ? isWriterFailure(reason.error) : Cause.isDieReason(reason) && isWriterFailure(reason.defect))
