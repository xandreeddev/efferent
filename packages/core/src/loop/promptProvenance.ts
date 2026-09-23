import { FiberRef, GlobalValue, Option } from "effect"
import type { PromptProvenance } from "../domain/prompt-provenance.entity.js"

export const CurrentPromptProvenance = GlobalValue.globalValue(
  "@xandreed/core/CurrentPromptProvenance",
  () => FiberRef.unsafeMake<Option.Option<PromptProvenance>>(Option.none()),
)
