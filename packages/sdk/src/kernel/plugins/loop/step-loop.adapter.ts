import { definePlugin, Loop } from "@xandreed/core/kernel"
import { makeStepLoop } from "./step-loop.usecase.js"

/**
 * The stock loop plugin: steps until the model asks for no tool, then the
 * reply. Its flow is `makeStepLoop`; the model call lives beside it.
 *
 * @public
 */
export const stepLoop = () => definePlugin({ name: "loop", version: "0.22.0", provides: Loop, make: makeStepLoop })
