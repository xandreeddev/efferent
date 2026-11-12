import { Layer } from "effect"
import { Loop } from "../../contracts/loop/loop.port.js"
import { makeStepLoop } from "./step-loop.usecase.js"

/**
 * The stock loop plugin: steps until the model asks for no tool, then the
 * reply. Its flow is `makeStepLoop`; the model call lives beside it. It
 * needs `Core`, `Sessions`, `Memory`, the model and `Settings`, and its
 * type says so.
 *
 * @public
 */
export const stepLoop = Layer.effect(Loop, makeStepLoop)
