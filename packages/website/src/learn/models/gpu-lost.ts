// What the page says when the GPU stops running a model in the browser (WebLLM), and which model it suggests instead.
//
// On a laptop GPU the driver resets the device when one request keeps it busy too long: the model reads the new part
// of a prompt in one go, so a long message, a long tool result, or a whole conversation read again (after the model is
// picked again) can be more than the GPU finishes in the time the driver allows. On one AMD integrated GPU (one run
// per size), Qwen2.5 0.5B was lost at about 570 new tokens and SmolLM2 360M on the GPU between 620 and 1,200, while
// SmolLM2 360M on the CPU read 1,200 in 20 seconds: no GPU driver stops a model on the processor. Picking the same
// model again in the same conversation makes it read all of it again, so the words point to a model on the CPU, or
// to Clear context.
import { Option, Order, Array as Arr } from "effect"
import type { Entry } from "./registry.ts"
import type { ModelChoice } from "./types.ts"

/** The largest model on the processor that this device can run, if there is one: no GPU driver can stop it. */
export const cpuModel = (entries: ReadonlyArray<Entry>): Option.Option<ModelChoice> =>
  Arr.head(Arr.sort(
    entries.filter((entry) => entry.choice.kind === "cpu" && entry.availability.state !== "unavailable").map((entry) => entry.choice),
    Order.flip(Order.mapInput(Order.Number, (choice: ModelChoice) => choice.downloadMB ?? 0)),
  ))

/** The chat's words when the GPU stopped running `lost`: what happened, why, and what to do next. */
export const gpuLostWords = (lost: ModelChoice, onCpu: Option.Option<ModelChoice>): string => {
  const again = `Picked again in this conversation, ${lost.label} would read all of it again and stop the same way.`
  const next = Option.match(onCpu, {
    onNone: () => `To go on, press Clear context and pick ${lost.label} again. ${again}`,
    onSome: (model) => `To go on, pick ${model.label}, which runs on the processor: slower, but no GPU driver stops it. Or press Clear context and pick ${lost.label} again. ${again}`,
  })
  return `The GPU stopped running ${lost.label}. Its driver reset it: one request gave the model more new text to read at once than this GPU finishes in the time the driver allows, or more than its memory holds. A long message, a long tool result, or a whole conversation read again does this on some laptop GPUs. Echo is active again. ${next}`
}
