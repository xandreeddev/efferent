import { harnessError } from "../harness/harness-code.entity.functions.js"
import { isTurnError } from "../session/sessions.entity.functions.js"
import type { TurnError } from "../session/sessions.entity.js"

/** Preserve turn failures at every interceptor/receipt edge; foreign evidence stays a cause. */
export const toolInterceptError = (cause: unknown): TurnError => isTurnError(cause)
  ? cause : harnessError("tool.intercept", "The tool interceptor could not finish the call.", cause)
