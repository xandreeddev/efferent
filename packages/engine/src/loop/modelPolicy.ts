import { FiberRef, Option } from "effect"
import type { ModelCallPolicy } from "../domain/model-call-policy.entity.js"

export const CurrentModelCallPolicy = FiberRef.unsafeMake<Option.Option<ModelCallPolicy>>(Option.none())
