import { Context } from "effect"
import type { ModelTarget } from "../prompt.entity.js"

/**
 * The model the current call is for. Prompts rendered without an explicit
 * target read it (with `serviceOption`); without one they render for
 * `{ model: "unknown", variant: "baseline" }`.
 */
export class CurrentModelTarget extends Context.Tag("efferent/ai/CurrentModelTarget")<CurrentModelTarget, ModelTarget>() {}
