import { Context, Option } from "effect"
import type { PromptProvenance } from "../domain/prompt-provenance.entity.js"

export const CurrentPromptProvenance = Context.Reference<Option.Option<PromptProvenance>>("@xandreed/core/CurrentPromptProvenance", { defaultValue: () => Option.none() })
