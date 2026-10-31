import { Context } from "effect"
import type { Effect } from "effect"
import type { AfterToolDecision, BeforeToolDecision, ToolInterceptAfterInput, ToolInterceptBeforeInput } from "../domain/tool-interceptor.entity.js"
import type { TurnError } from "../session/sessions.entity.js"

/** Optional host policy after ActionPolicy; callback evidence and decisions use encoded JSON. @public */
export class ToolInterceptor extends Context.Service<ToolInterceptor, {
  readonly before: (input: ToolInterceptBeforeInput) => Effect.Effect<BeforeToolDecision, TurnError>
  readonly after: (input: ToolInterceptAfterInput) => Effect.Effect<AfterToolDecision, TurnError>
}>()("@xandreed/core/ToolInterceptor") {}
