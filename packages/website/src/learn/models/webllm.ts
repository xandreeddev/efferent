// Small open models through WebLLM (WebGPU). The library is imported only when
// a learner picks one, so the lesson page stays light.
import { Effect } from "effect"
import type { ChatMessage, Usage } from "../prompt-map.ts"
import { estimateTokens, settledParts, toChatMessages, usageOf } from "../prompt-map.ts"
import { makeBrowserModel } from "./make.ts"
import { aiError, modelStream } from "./stream.ts"
import type { Availability, LoadedModel, LoadProgress, ModelChoice } from "./types.ts"

export interface Chunk {
  readonly choices: ReadonlyArray<{ readonly delta?: { readonly content?: string | null } }>
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number }
}

/** The slice of WebLLM's engine this adapter uses. */
export interface Engine {
  chat: {
    completions: {
      create(request: {
        messages: ReadonlyArray<ChatMessage>
        stream: boolean
        max_tokens?: number
        stream_options?: { include_usage: boolean }
      }): Promise<AsyncIterable<Chunk>>
    }
  }
  interruptGenerate(): void
  /** Clears the conversation and the cached keys and values the engine keeps between requests. */
  resetChat?(): Promise<void>
  unload(): Promise<void>
}

/** Where WebLLM keeps downloaded weights: the Cache API (its default) or IndexedDB. */
export type CacheBackend = "cache" | "indexeddb"

export interface WebLlmModule {
  CreateMLCEngine(
    id: string,
    config: {
      initProgressCallback: (report: { progress: number; text: string }) => void
      appConfig?: { model_list: ReadonlyArray<{ model_id: string; vram_required_MB?: number }>; cacheBackend?: CacheBackend }
    },
  ): Promise<Engine>
  prebuiltAppConfig: { model_list: ReadonlyArray<{ model_id: string; vram_required_MB?: number }> }
}

/** Ids and memory from WebLLM's prebuilt list (the test checks them against the installed version). */
export const webllmChoices: ReadonlyArray<ModelChoice> = [
  { id: "smollm2-360m", kind: "webllm", label: "SmolLM2 360M", blurb: "Tiny and fast. Follows simple instructions; forgets quickly.", memoryMB: 376, contextTokens: 4096,
    webllm: { f16: "SmolLM2-360M-Instruct-q4f16_1-MLC", f32: "SmolLM2-360M-Instruct-q4f32_1-MLC", memoryF32MB: 580 } },
  { id: "qwen2.5-0.5b", kind: "webllm", label: "Qwen2.5 0.5B", blurb: "Small, multilingual, a good first real model.", memoryMB: 945, contextTokens: 4096,
    webllm: { f16: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", f32: "Qwen2.5-0.5B-Instruct-q4f32_1-MLC", memoryF32MB: 1060 } },
  { id: "llama-3.2-1b", kind: "webllm", label: "Llama 3.2 1B", blurb: "Meta's small model: clearer answers, still quick.", memoryMB: 879, contextTokens: 4096,
    webllm: { f16: "Llama-3.2-1B-Instruct-q4f16_1-MLC", f32: "Llama-3.2-1B-Instruct-q4f32_1-MLC", memoryF32MB: 1129 } },
  { id: "phi-3.5-mini", kind: "webllm", label: "Phi-3.5 mini", blurb: "Microsoft's 3.8B model: the strongest here, the biggest download.", memoryMB: 3672, contextTokens: 4096,
    webllm: { f16: "Phi-3.5-mini-instruct-q4f16_1-MLC", f32: "Phi-3.5-mini-instruct-q4f32_1-MLC", memoryF32MB: 5483 } },
]

export interface GpuProbe {
  readonly webgpu: boolean
  readonly f16: boolean
  /** Chrome offers WebGPU only in "compatibility mode" (typically Linux with Vulkan off): the models cannot use it. */
  readonly compatOnly: boolean
  /** A short description of the adapter, when there is one (for example "amd rdna-2"). */
  readonly adapter?: string
}

type AdapterLike = { features: { has(name: string): boolean }; info?: { vendor?: string; architecture?: string } }
type GpuApi = { requestAdapter(options?: { featureLevel?: string }): Promise<AdapterLike | null> }

const NONE: GpuProbe = { webgpu: false, f16: false, compatOnly: false }

export const probeGpu = async (host: unknown = globalThis): Promise<GpuProbe> => {
  const nav = typeof host === "object" && host !== null && "navigator" in host ? (host as { navigator: { gpu?: GpuApi } }).navigator : undefined
  if (nav?.gpu === undefined) return NONE
  // requestAdapter can hang on some drivers: give it two seconds, then call it absent.
  const ask = (options?: { featureLevel?: string }) =>
    Promise.race([nav.gpu!.requestAdapter(options), new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))]).catch(() => null)
  const adapter = await ask()
  if (adapter !== null) {
    const info = [adapter.info?.vendor, adapter.info?.architecture].filter((part) => part !== undefined && part !== "").join(" ")
    return { webgpu: true, f16: adapter.features.has("shader-f16"), compatOnly: false, ...(info ? { adapter: info } : {}) }
  }
  // No standard adapter. If a compatibility-mode one exists, say so: the fix is different (enable Vulkan).
  const compat = await ask({ featureLevel: "compatibility" })
  return compat !== null ? { ...NONE, compatOnly: true } : NONE
}

export const webllmAvailability = (probe: GpuProbe): Availability =>
  probe.webgpu ? { state: "downloadable" }
    : probe.compatOnly ? { state: "unavailable", reason: "Chrome is offering WebGPU only in compatibility mode (its Vulkan support is off), and these models cannot run in that mode." }
      : { state: "unavailable", reason: "WebGPU is not available in this browser or on this device." }

/** The id and memory to use on this GPU. */
export const variantFor = (choice: ModelChoice, probe: GpuProbe): { id: string; memoryMB: number } => {
  const spec = choice.webllm
  if (spec === undefined) throw new Error(`${choice.id} is not a WebLLM model`)
  return probe.f16 ? { id: spec.f16, memoryMB: choice.memoryMB } : { id: spec.f32, memoryMB: spec.memoryF32MB }
}

/** Replies stop here: a small model can ramble until its context is full, minutes of GPU time in a tutorial. */
const MAX_REPLY_TOKENS = 512

export interface LoadOptions {
  /** Give up on an attempt when its progress has not changed for this long. */
  readonly stallMs: number
  /** Further attempts after a failed or stalled one; files already saved by the browser are reused. */
  readonly retries: number
  readonly backoffMs: number
}

const DEFAULT_LOAD: LoadOptions = { stallMs: 45_000, retries: 2, backoffMs: 2_000 }

/**
 * Two messages from the same role in a row (a stopped turn leaves your message without a reply, and the
 * next one follows it) are sent as one: chat templates expect the roles to alternate.
 */
export const alternating = (messages: ReadonlyArray<ChatMessage>): ReadonlyArray<ChatMessage> =>
  messages.reduce<ChatMessage[]>((out, message) => {
    const last = out.at(-1)
    return last !== undefined && last.role === message.role && message.role !== "system"
      ? [...out.slice(0, -1), { ...last, content: `${last.content}\n\n${message.content}` }]
      : [...out, message]
  }, [])

/** Unloading waits for the generation in flight; after a lost device that may never end, so waiting is bounded. */
const UNLOAD_WAIT_MS = 4_000

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

/** "about 3 min left", from the share done and the time spent (nothing before there is enough to go on). */
const etaOf = (fraction: number, elapsedMs: number): string => {
  if (fraction < 0.03 || elapsedMs < 8_000) return ""
  const left = (elapsedMs * (1 - fraction)) / fraction / 1000
  return left < 90 ? ` · about ${Math.max(5, Math.round(left / 5) * 5)} s left` : ` · about ${Math.round(left / 60)} min left`
}

/**
 * One attempt at WebLLM's engine, abandoned if its progress stops moving: a
 * stalled download otherwise leaves the learner watching a frozen bar. The
 * library has no way to cancel, so an abandoned attempt may finish in the
 * background; the next one reuses what it already saved.
 */
const attemptEngine = (
  webllm: WebLlmModule,
  id: string,
  backend: CacheBackend,
  onProgress: (progress: LoadProgress) => void,
  stallMs: number,
): Promise<Engine> => new Promise((resolve, reject) => {
  const started = Date.now()
  let settled = false
  let last = { fraction: 0, text: "" }
  let changedAt = Date.now()
  const finish = (action: () => void) => { if (!settled) { settled = true; clearInterval(watchdog); action() } }
  const watchdog = setInterval(() => {
    if (Date.now() - changedAt >= stallMs) {
      finish(() => reject(new Error(`The download stalled at ${Math.round(last.fraction * 100)}%: no progress for ${Math.round(stallMs / 1000)} s.`)))
    }
  }, Math.max(10, Math.min(1_000, Math.floor(stallMs / 4))))
  webllm.CreateMLCEngine(id, {
    appConfig: { ...webllm.prebuiltAppConfig, cacheBackend: backend },
    initProgressCallback: (report) => {
      if (settled) return
      if (report.text !== last.text || report.progress !== last.fraction) changedAt = Date.now()
      last = { fraction: report.progress, text: report.text }
      onProgress({ fraction: report.progress, text: `${report.text}${etaOf(report.progress, Date.now() - started)}` })
    },
  }).then(
    (engine) => finish(() => resolve(engine)),
    (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
  )
})

/** What the browser lets this site store and how much is used: a full disk or a small quota both fail a download oddly. */
const storageNote = async (): Promise<string> => {
  try {
    const estimate = await globalThis.navigator?.storage?.estimate?.()
    if (!estimate?.quota) return ""
    const gb = (bytes: number) => (bytes / 1e9).toFixed(1)
    return ` The browser reports ${gb(estimate.usage ?? 0)} GB used of ${gb(estimate.quota)} GB allowed for this site; the model needs about as much free space as its download, and the disk itself must have it too.`
  } catch { return "" }
}

const backendKey = (id: string) => `efferent-learn:webllm-cache:${id}`

/** The storage that last held this model completely: weights saved in one are not found in the other. */
const rememberedBackend = (id: string): CacheBackend => {
  try { return globalThis.localStorage?.getItem(backendKey(id)) === "indexeddb" ? "indexeddb" : "cache" } catch { return "cache" }
}
const rememberBackend = (id: string, backend: CacheBackend) => {
  try { globalThis.localStorage?.setItem(backendKey(id), backend) } catch { /* private window or blocked storage: the default applies next time */ }
}

export const loadWebLlm = async (
  choice: ModelChoice,
  probe: GpuProbe,
  onProgress: (progress: LoadProgress) => void,
  load: () => Promise<WebLlmModule> = () => import("@mlc-ai/web-llm") as unknown as Promise<WebLlmModule>,
  options: LoadOptions = DEFAULT_LOAD,
): Promise<LoadedModel> => {
  const { id } = variantFor(choice, probe)
  const webllm = await load()
  if (!webllm.prebuiltAppConfig.model_list.some((entry) => entry.model_id === id)) throw new Error(`This WebLLM version has no model ${id}.`)
  // The last attempt uses the other storage: a failure inside the browser's Cache API ("Cache.add()
  // encountered a network error") often does not happen in IndexedDB, and the two do not share files.
  const first = rememberedBackend(id)
  const other: CacheBackend = first === "cache" ? "indexeddb" : "cache"
  let engine: Engine | undefined
  let used = first
  for (let attempt = 0; engine === undefined; attempt += 1) {
    used = attempt > 0 && attempt === options.retries ? other : first
    try {
      engine = await attemptEngine(webllm, id, used, onProgress, options.stallMs)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (attempt >= options.retries) {
        throw new Error(`${reason} It failed in both of the browser's download stores (Cache and IndexedDB). Check for a VPN, proxy or content blocker affecting huggingface.co and its CDN, make sure the disk has room, or clear this site's storage in DevTools (Application, Storage), then choose the model again.${await storageNote()}`)
      }
      const next = attempt + 1 === options.retries ? other : first
      const switching = next !== used ? ` Switching the download store to ${next === "indexeddb" ? "IndexedDB" : "the Cache API"}; weights saved in the other one are not reused.` : " Files already saved are reused."
      onProgress({ fraction: 0, text: `${reason} Trying again (${attempt + 2} of ${options.retries + 1}).${switching}` })
      await pause(options.backoffMs)
    }
  }
  rememberBackend(id, used)
  // Requests are numbered as they are made, and Stop covers every request made so far: one that is still
  // waiting its turn on the GPU is skipped, because WebLLM forgets an interrupt when a generation starts.
  let issued = 0
  let stoppedUpTo = 0
  const interrupt = () => { stoppedUpTo = issued; engine.interruptGenerate() }
  // One generation on the GPU at a time, and a stopped one is read to its end: a new request that starts
  // while the last step's results are still being read back loses the device ("Buffer was unmapped before
  // mapping was resolved", then "Device was lost").
  let gate: Promise<unknown> = Promise.resolve()
  // A stopped generation leaves the engine's cached keys and values part-way through a reply. The next request, which
  // reuses that cache for the shared start of its prompt, then loses the GPU device on some histories, so a stop starts clean.
  const clearAfterStop = () => (engine.resetChat?.() ?? Promise.resolve()).catch(() => undefined)
  const exclusive = <A>(task: () => Promise<A>): Promise<A> => {
    const run = gate.then(task, task)
    gate = run.catch(() => undefined)
    return run
  }

  const model = makeBrowserModel({
    generateText: (options) => Effect.tryPromise({
      try: () => { issued += 1; const ticket = issued; return exclusive(async () => {
        const messages = alternating(toChatMessages(options.prompt))
        if (ticket <= stoppedUpTo) return settledParts("", usageOf(messages, "")) as never
        const chunks = await engine.chat.completions.create({ messages, stream: true, max_tokens: MAX_REPLY_TOKENS, stream_options: { include_usage: true } })
        let reply = ""
        for await (const chunk of chunks) reply += chunk.choices[0]?.delta?.content ?? ""
        return settledParts(reply, usageOf(messages, reply)) as never
      }) },
      catch: (error) => aiError("WebLLM", "generateText", error),
    }),
    streamText: (options) => {
      const messages = alternating(toChatMessages(options.prompt))
      return modelStream("WebLLM", (sink) => {
        let reply = ""
        issued += 1
        const ticket = issued
        const stopped = () => ticket <= stoppedUpTo
        void exclusive(async () => {
          if (stopped()) { sink.end(usageOf(messages, "")); return }
          let reported: Usage | undefined
          try {
            const chunks = await engine.chat.completions.create({ messages, stream: true, max_tokens: MAX_REPLY_TOKENS, stream_options: { include_usage: true } })
            // After Stop the loop keeps reading: WebLLM ends the stream itself once the step in flight is done.
            for await (const chunk of chunks) {
              if (chunk.usage !== undefined) reported = { inputTokens: { total: chunk.usage.prompt_tokens }, outputTokens: { total: chunk.usage.completion_tokens } }
              const delta = chunk.choices[0]?.delta?.content ?? ""
              if (delta.length > 0 && !stopped()) { reply += delta; sink.push(delta) }
            }
            if (stopped()) await clearAfterStop()
            sink.end(reported ?? { inputTokens: { total: estimateTokens(messages.map((m) => m.content).join("\n")) }, outputTokens: { total: estimateTokens(reply) } })
          } catch (error) {
            if (stopped()) { await clearAfterStop(); sink.end(usageOf(messages, reply)) }
            else sink.fail(error)
          }
        })
        return interrupt
      }) as never
    },
  })

  return { choice, model, interrupt, dispose: () => Promise.race([exclusive(() => engine.unload()).catch(() => undefined), pause(UNLOAD_WAIT_MS)]) }
}
