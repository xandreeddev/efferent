// The catalogue the model picker shows, and the one function that loads any of them.
import { chromeAvailability, chromeChoice, loadChrome, promptApiOf } from "./chrome-prompt.ts"
import { cpuChoices, loadCpu } from "./cpu.ts"
import { echoChoice, loadEcho } from "./mock.ts"
import { loadWebLlm, probeGpu, variantFor, webllmAvailability, webllmChoices } from "./webllm.ts"
import type { GpuProbe } from "./webllm.ts"
import type { Availability, LoadedModel, LoadProgress, ModelChoice } from "./types.ts"

export interface Entry {
  readonly choice: ModelChoice
  readonly availability: Availability
  /** One line on how to make an unavailable model work, or why it cannot. */
  readonly fix?: string
}

export interface Device {
  readonly gpu: GpuProbe
  readonly chrome: Availability
}

export const probeDevice = async (): Promise<Device> => ({
  gpu: await probeGpu(),
  chrome: await chromeAvailability(promptApiOf()),
})

const wasm = typeof WebAssembly === "object"

/** How to make a GPU model work, for what this browser reported. */
const gpuFix = (device: Device): string =>
  device.gpu.compatOnly
    ? "Your GPU is fine: Chrome is just not using Vulkan, so it only offers WebGPU in compatibility mode. On Linux, enable Vulkan: start Chrome with --enable-features=Vulkan --use-angle=vulkan --enable-unsafe-webgpu (add Vulkan to your existing --enable-features list if you have one; on Arch these go in ~/.config/chrome-flags.conf), restart Chrome fully, then check that chrome://gpu shows Vulkan as Enabled. This worked on Chrome 156 with an AMD GPU and Mesa's RADV driver; flag names can change between Chrome versions."
    : "This model runs on your graphics card through WebGPU, so it cannot run on a machine without it. Open chrome://gpu and check whether WebGPU is listed as hardware accelerated; if it is not, Chrome's WebGPU documentation on developer.chrome.com covers drivers and settings for your system. Otherwise pick a CPU model."

export const catalogue = (device: Device): ReadonlyArray<Entry> => [
  { choice: echoChoice, availability: { state: "ready" } },
  ...cpuChoices.map((choice): Entry => ({
    choice,
    availability: wasm ? { state: "downloadable" } : { state: "unavailable", reason: "This browser cannot run WebAssembly." },
  })),
  {
    choice: chromeChoice,
    availability: device.chrome,
    fix: "Needs desktop Chrome 148 or newer with the on-device model available. Open chrome://on-device-internals to see its status; Chrome's documentation for the Prompt API lists the hardware it needs (about 22 GB of free disk, and a GPU with more than 4 GB of memory or 16 GB of RAM and 4 cores) and any settings to enable.",
  },
  ...webllmChoices.map((choice): Entry => ({
    choice,
    availability: webllmAvailability(device.gpu),
    fix: gpuFix(device),
  })),
]

export const sizeText = (choice: ModelChoice, device: Device): string => {
  if (choice.kind === "echo") return "no download"
  if (choice.kind === "chrome") return "managed by Chrome"
  if (choice.kind === "cpu") return `${choice.downloadMB} MB download`
  const { memoryMB } = variantFor(choice, device.gpu)
  return `~${memoryMB >= 1000 ? (memoryMB / 1000).toFixed(1) + " GB" : memoryMB + " MB"} GPU memory`
}

export const loadModel = (choice: ModelChoice, device: Device, onProgress: (progress: LoadProgress) => void): Promise<LoadedModel> => {
  if (choice.kind === "echo") return Promise.resolve(loadEcho())
  if (choice.kind === "chrome") return loadChrome(onProgress)
  if (choice.kind === "cpu") return loadCpu(choice, onProgress)
  return loadWebLlm(choice, device.gpu, onProgress)
}
