import { Context, Option } from "effect"
import type { ModelCallId, ModelCallMethod, ModelCallPurpose, ModelSelection } from "@xandreed/core"

/** Private execution-time purpose; utilities provide Helper without recording another call. */
export const CurrentModelCallPurpose = Context.Reference<ModelCallPurpose>("@xandreed/plugin-models/CurrentModelCallPurpose", { defaultValue: () => "Loop" })
/** Private invocation metadata; a routed object call can use a provider's text implementation. */
export const CurrentModelCallMethod = Context.Reference<ModelCallMethod>("@xandreed/plugin-models/CurrentModelCallMethod", { defaultValue: () => "Text" })
export const CurrentModelCallSelection = Context.Reference<Option.Option<ModelSelection>>("@xandreed/plugin-models/CurrentModelCallSelection", { defaultValue: () => Option.none() })

/** Identifies which logical budget owns inherited invocation metadata. */
export const CurrentModelCallMetadataOwner = Context.Reference<Option.Option<ModelCallId>>("@xandreed/plugin-models/CurrentModelCallMetadataOwner", { defaultValue: () => Option.none() })
