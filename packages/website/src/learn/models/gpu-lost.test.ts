import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { cpuModel, gpuLostWords } from "./gpu-lost.ts"
import { catalogue } from "./registry.ts"
import type { Device } from "./registry.ts"
import { webllmChoices } from "./webllm.ts"

const device: Device = { gpu: { webgpu: true, f16: true, compatOnly: false }, chrome: { state: "unavailable", reason: "no" } }
const qwen = webllmChoices.find((one) => one.id === "qwen2.5-0.5b") ?? expect.unreachable("no Qwen choice")

describe("the words when the GPU stops running a model", () => {
  test("the model suggested is the largest on the processor, which no GPU driver stops", () => {
    expect(Option.map(cpuModel(catalogue(device)), (one) => one.id)).toEqual(Option.some("cpu-smollm2-360m"))
    // Where the browser cannot run one, none is suggested.
    expect(cpuModel(catalogue(device).filter((entry) => entry.choice.kind !== "cpu"))).toEqual(Option.none())
  })

  test("with a model on the processor to pick: what happened, why, and the two ways on, word for word", () => {
    expect(gpuLostWords(qwen, cpuModel(catalogue(device)))).toBe(
      "The GPU stopped running Qwen2.5 0.5B. Its driver reset it: one request gave the model more new text to read at once than this GPU finishes in the time the driver allows, or more than its memory holds. A long message, a long tool result, or a whole conversation read again does this on some laptop GPUs. Echo is active again. To go on, pick SmolLM2 360M (CPU), which runs on the processor: slower, but no GPU driver stops it. Or press Clear context and pick Qwen2.5 0.5B again. Picked again in this conversation, Qwen2.5 0.5B would read all of it again and stop the same way.",
    )
  })

  test("with none on the processor: Clear context, and why picking the same model again is not enough", () => {
    expect(gpuLostWords(qwen, Option.none())).toBe(
      "The GPU stopped running Qwen2.5 0.5B. Its driver reset it: one request gave the model more new text to read at once than this GPU finishes in the time the driver allows, or more than its memory holds. A long message, a long tool result, or a whole conversation read again does this on some laptop GPUs. Echo is active again. To go on, press Clear context and pick Qwen2.5 0.5B again. Picked again in this conversation, Qwen2.5 0.5B would read all of it again and stop the same way.",
    )
  })
})
