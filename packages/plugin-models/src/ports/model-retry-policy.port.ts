import { Context, Option } from "effect"
import { modelRetryDefaults } from "../llm/model-retry-policy.entity.js"
import type { ModelRetryPolicy } from "../llm/model-retry-policy.entity.js"
import type { ModelRequestCall } from "../transport/resilient-http-client.adapter.js"

/** Read when a logical model call executes; the complete policy overrides the defaults. @public */
export const CurrentModelRetryPolicy = Context.Reference<ModelRetryPolicy>("@xandreed/plugin-models/CurrentModelRetryPolicy", { defaultValue: () => modelRetryDefaults })

/** Private per-call counter/deadline, shared only by its primary and fallback rung. */
export const CurrentModelRequestCall = Context.Reference<Option.Option<ModelRequestCall>>("@xandreed/plugin-models/CurrentModelRequestCall", { defaultValue: () => Option.none() })
