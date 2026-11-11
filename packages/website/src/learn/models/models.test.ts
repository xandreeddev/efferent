import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { chromeAvailability, loadChrome, promptApiOf, splitForPrompt } from "./chrome-prompt.ts"
import type { PromptApi } from "./chrome-prompt.ts"
import { echoReply, loadEcho } from "./mock.ts"
import { cpuChoices, loadCpu } from "./cpu.ts"
import type { WorkerLike } from "./cpu.ts"
import { loadWebLlm, probeGpu, variantFor, webllmAvailability, webllmChoices } from "./webllm.ts"
import type { Chunk, Engine, WebLlmModule } from "./webllm.ts"
import { deltaReader, toChatMessages } from "../prompt-map.ts"
import type { LoadedModel } from "./types.ts"

const textOf = (parts: ReadonlyArray<{ type: string; delta?: string }>) => parts.flatMap((p) => (p.type === "text-delta" ? [p.delta ?? ""] : [])).join("")

const stream = (loaded: LoadedModel, prompt: string) =>
  Stream.runCollect(LanguageModel.streamText({ prompt })).pipe(
    Effect.provideService(LanguageModel.LanguageModel, loaded.model),
    Effect.map((parts) => parts as unknown as ReadonlyArray<{ type: string; delta?: string }>),
  )

const within = <A>(promise: Promise<A>, ms: number): Promise<A> =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still running after ${ms}ms`)), ms))])

describe("prompt mapping", () => {
  test("the stream reader decides cumulative vs delta on the second chunk", () => {
    const cumulative = deltaReader()
    expect([cumulative("Hel"), cumulative("Hello"), cumulative("Hello wor")]).toEqual(["Hel", "lo", " wor"])
    const deltas = deltaReader()
    expect([deltas("Hel"), deltas("lo"), deltas(" world")]).toEqual(["Hel", "lo", " world"])
  })

  test("splitForPrompt prompts with the last user message and keeps the rest as history", () => {
    const messages = [{ role: "system", content: "s" }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] as const
    expect(splitForPrompt(messages)).toEqual({ history: messages.slice(0, 3), input: "c" })
  })
})

describe("echo model", () => {
  const sys = { role: "system", content: "You are a tutor." } as const
  const user = (content: string) => ({ role: "user", content }) as const
  const agent = (content: string) => ({ role: "assistant", content }) as const

  test("streams the reply as deltas", async () => {
    const parts = await Effect.runPromise(stream(loadEcho(), "ping"))
    expect(textOf(parts)).toContain("You said: \"ping\"")
    expect(parts.at(-1)?.type).toBe("finish")
  })

  test("never repeats the system prompt back", () => {
    expect(echoReply([sys, user("tell me something")])).not.toContain("tutor")
  })

  test("a first message says it is the start of the conversation", () => {
    expect(echoReply([sys, user("tell me something")])).toBe('You said: "tell me something". This is the start of the conversation.')
  })

  test("it recalls what you said from the history it was sent", () => {
    const reply = echoReply([sys, user("my name is Sam"), agent("Hi Sam"), user("what did I say earlier?")])
    expect(reply).toBe('Earlier you said: "my name is Sam".')
  })

  test("asked to recall with nothing earlier, it says so", () => {
    expect(echoReply([sys, user("do you remember me?")])).toBe("This is the first message, so I have nothing earlier to recall.")
  })

  test("it admits when older turns were condensed into a note", () => {
    const note = user("[Host note: earlier turns were condensed to free context.]\n\nEarlier in this conversation:\n- Asked: hi")
    const reply = echoReply([sys, note, user("what did we talk about earlier?")])
    expect(reply).toContain("only have a condensed note")
    expect(reply).toContain("condensed into a short note")
  })

  test("it describes its context when asked", () => {
    expect(echoReply([sys, user("hi there"), agent("hello"), user("what is in your context?")]))
      .toBe("I was sent a system prompt of 16 characters, 2 earlier messages, and your message.")
  })

  test("a greeting introduces it", () => {
    expect(echoReply([sys, user("hello")])).toContain("I'm Echo")
  })
})

describe("chrome built-in model adapter (fake Prompt API)", () => {
  const fake = (chunks: ReadonlyArray<string>, hang = false): PromptApi => ({
    availability: async () => "available",
    create: async () => ({
      promptStreaming: (_input, options) => new ReadableStream<string>({
        start: (controller) => {
          if (hang) { options?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError"))); return }
          chunks.forEach((chunk) => controller.enqueue(chunk))
          controller.close()
        },
      }),
      prompt: async () => chunks.join(""),
      destroy: () => {},
    }),
  })

  test("finds the API when the global is a class with static methods, as in a browser", () => {
    class LanguageModel {
      static availability = async () => "available"
      static create = async () => ({ promptStreaming: () => new ReadableStream<string>(), prompt: async () => "", destroy: () => {} })
    }
    expect(promptApiOf({ LanguageModel })).toBe(LanguageModel as never)
    expect(promptApiOf({})).toBeUndefined()
    expect(promptApiOf({ LanguageModel: 3 })).toBeUndefined()
  })

  test("availability maps the API's states", async () => {
    expect(await chromeAvailability(fake([]))).toEqual({ state: "ready" })
    expect(await chromeAvailability({ ...fake([]), availability: async () => "downloadable" })).toEqual({ state: "downloadable" })
    expect((await chromeAvailability({ ...fake([]), availability: async () => "unavailable" })).state).toBe("unavailable")
    expect((await chromeAvailability(undefined)).state).toBe("unavailable")
  })

  test("cumulative chunks stream as deltas", async () => {
    const loaded = await loadChrome(() => {}, fake(["He", "Hello", "Hello there"]))
    expect(textOf(await Effect.runPromise(stream(loaded, "hi")))).toBe("Hello there")
  })

  test("Stop ends a stalled stream promptly, by interrupt and by fiber interruption", async () => {
    const loaded = await loadChrome(() => {}, fake([], true))
    const running = Effect.runPromise(stream(loaded, "hi"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    loaded.interrupt()
    await within(running, 500)

    const fiber = Effect.runFork(stream(loaded, "again"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await within(Effect.runPromise(Fiber.interrupt(fiber)), 500)
  })
})

describe("WebLLM adapter (fake engine)", () => {
  const engineOf = (chunks: ReadonlyArray<Chunk>, stall = false): { engine: Engine; interrupted: () => boolean } => {
    let interrupted = false
    return {
      interrupted: () => interrupted,
      engine: {
        chat: { completions: { create: async () => (async function* () {
          for (const chunk of chunks) { if (interrupted) return; yield chunk }
          while (stall && !interrupted) await new Promise((resolve) => setTimeout(resolve, 5))
        })() } },
        interruptGenerate: () => { interrupted = true },
        unload: async () => {},
      },
    }
  }
  const moduleOf = (engine: Engine): WebLlmModule => ({
    CreateMLCEngine: async (_id, config) => { config.initProgressCallback({ progress: 1, text: "done" }); return engine },
    prebuiltAppConfig: { model_list: webllmChoices.flatMap((c) => [{ model_id: c.webllm!.f16 }, { model_id: c.webllm!.f32 }]) },
  })
  const delta = (content: string): Chunk => ({ choices: [{ delta: { content } }] })
  const choice = webllmChoices[0]!

  test("variantFor picks half precision only when the GPU has it", () => {
    expect(variantFor(choice, { webgpu: true, f16: true, compatOnly: false }).id).toBe("SmolLM2-360M-Instruct-q4f16_1-MLC")
    expect(variantFor(choice, { webgpu: true, f16: false, compatOnly: false })).toEqual({ id: "SmolLM2-360M-Instruct-q4f32_1-MLC", memoryMB: 580 })
  })

  test("streams deltas and uses the reported usage", async () => {
    const { engine } = engineOf([delta("Hi"), delta(" there"), { choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } }])
    const loaded = await loadWebLlm(choice, { webgpu: true, f16: true, compatOnly: false }, () => {}, async () => moduleOf(engine))
    const parts = await Effect.runPromise(stream(loaded, "hello"))
    expect(textOf(parts)).toBe("Hi there")
    expect(JSON.stringify(parts.at(-1))).toContain("\"total\":7")
  })

  test("Stop interrupts the engine and ends the stream promptly", async () => {
    const { engine, interrupted } = engineOf([delta("a")], true)
    const loaded = await loadWebLlm(choice, { webgpu: true, f16: true, compatOnly: false }, () => {}, async () => moduleOf(engine))
    const running = Effect.runPromise(stream(loaded, "hello"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    loaded.interrupt()
    expect(textOf(await within(running, 500))).toBe("a")
    expect(interrupted()).toBe(true)
  })

  /** Behaves like WebLLM: a generation resets the interrupt flag when it starts, and ends a little after an interrupt. */
  const gpuEngine = () => {
    let signal = false
    let active = 0
    const seen = { most: 0, started: 0, unloadedWhileActive: false }
    const engine: Engine = {
      chat: { completions: { create: async () => (async function* () {
        signal = false
        seen.started += 1
        active += 1; seen.most = Math.max(seen.most, active)
        try {
          yield delta("a")
          while (!signal) await new Promise((resolve) => setTimeout(resolve, 5))
          await new Promise((resolve) => setTimeout(resolve, 30)) // the decode step still in flight
        } finally { active -= 1 }
      })() } },
      interruptGenerate: () => { signal = true },
      unload: async () => { if (active > 0) seen.unloadedWhileActive = true },
    }
    return { engine, seen }
  }
  const gpuChoiceProbe = { webgpu: true, f16: true, compatOnly: false }

  test("a request made after Stop waits for the stopped one to finish on the GPU", async () => {
    const { engine, seen } = gpuEngine()
    const loaded = await loadWebLlm(choice, gpuChoiceProbe, () => {}, async () => moduleOf(engine))
    const first = Effect.runPromise(stream(loaded, "one"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    loaded.interrupt()
    const second = Effect.runPromise(stream(loaded, "two")) // made after Stop, so it is not cancelled
    await new Promise((resolve) => setTimeout(resolve, 80))
    loaded.interrupt()
    await Promise.all([within(first, 2000), within(second, 2000)])
    expect(seen.started).toBe(2)
    expect(seen.most).toBe(1)
    await loaded.dispose()
    expect(seen.unloadedWhileActive).toBe(false)
  })

  test("Stop cancels a request that is still waiting its turn: it never reaches the GPU", async () => {
    const { engine, seen } = gpuEngine()
    const loaded = await loadWebLlm(choice, gpuChoiceProbe, () => {}, async () => moduleOf(engine))
    const first = Effect.runPromise(stream(loaded, "one"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const queued = Effect.runPromise(stream(loaded, "two")) // waits behind the first
    await new Promise((resolve) => setTimeout(resolve, 10))
    loaded.interrupt() // covers both
    const [, second] = await Promise.all([within(first, 2000), within(queued, 2000)])
    expect(seen.started).toBe(1)
    expect(textOf(second)).toBe("")
  })

  test("a stopped generation clears the engine's cached state; a finished one does not", async () => {
    const { engine } = gpuEngine()
    let resets = 0
    const loaded = await loadWebLlm(choice, gpuChoiceProbe, () => {}, async () => moduleOf({ ...engine, resetChat: async () => { resets += 1 } }))
    const running = Effect.runPromise(stream(loaded, "one"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    loaded.interrupt()
    await within(running, 2000)
    expect(resets).toBe(1)
    const { engine: finishing } = engineOf([delta("done")])
    let finishedResets = 0
    const other = await loadWebLlm(choice, gpuChoiceProbe, () => {}, async () => moduleOf({ ...finishing, resetChat: async () => { finishedResets += 1 } }))
    await Effect.runPromise(stream(other, "hello"))
    expect(finishedResets).toBe(0)
  })

  test("unloading does not wait for ever on a generation that never ends", async () => {
    const hung: Engine = {
      chat: { completions: { create: async () => (async function* () { yield delta("a"); await new Promise(() => {}) })() } },
      interruptGenerate: () => {},
      unload: async () => {},
    }
    const loaded = await loadWebLlm(choice, gpuChoiceProbe, () => {}, async () => moduleOf(hung))
    void Effect.runPromise(stream(loaded, "one"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const started = performance.now()
    await loaded.dispose()
    expect(performance.now() - started).toBeLessThan(6000)
  }, 8000)

  test("a model id the installed library lacks is a readable error", async () => {
    const { engine } = engineOf([])
    const empty: WebLlmModule = { ...moduleOf(engine), prebuiltAppConfig: { model_list: [] } }
    await expect(loadWebLlm(choice, { webgpu: true, f16: true, compatOnly: false }, () => {}, async () => empty)).rejects.toThrow("has no model")
  })

  test("a download that stalls is abandoned and retried, and the learner is told", async () => {
    const { engine } = engineOf([delta("ok")])
    let calls = 0
    const stalling: WebLlmModule = {
      ...moduleOf(engine),
      CreateMLCEngine: (_id, config) => {
        calls += 1
        if (calls === 1) { config.initProgressCallback({ progress: 0.5, text: "Fetching param cache[41/83]" }); return new Promise(() => {}) }
        config.initProgressCallback({ progress: 1, text: "done" })
        return Promise.resolve(engine)
      },
    }
    const seen: string[] = []
    const loaded = await loadWebLlm(choice, { webgpu: true, f16: true, compatOnly: false }, (p) => seen.push(p.text), async () => stalling, { stallMs: 40, retries: 2, backoffMs: 1 })
    expect(calls).toBe(2)
    expect(seen.some((text) => text.includes("stalled at 50%") && text.includes("Trying again (2 of 3)"))).toBe(true)
    expect(textOf(await Effect.runPromise(stream(loaded, "hello")))).toBe("ok")
  })

  test("a download that keeps failing ends with what happened and what to do", async () => {
    const { engine } = engineOf([])
    const failing: WebLlmModule = { ...moduleOf(engine), CreateMLCEngine: () => Promise.reject(new Error("Cache.add() encountered a network error")) }
    await expect(loadWebLlm(choice, { webgpu: true, f16: true, compatOnly: false }, () => {}, async () => failing, { stallMs: 1000, retries: 1, backoffMs: 1 }))
      .rejects.toThrow(/network error[\s\S]*both of the browser's download stores[\s\S]*clear this site's storage/)
  })

  test("when the Cache API keeps failing, the last attempt uses IndexedDB", async () => {
    const { engine } = engineOf([delta("ok")])
    const used: Array<string | undefined> = []
    const flaky: WebLlmModule = {
      ...moduleOf(engine),
      CreateMLCEngine: (_id, config) => {
        used.push(config.appConfig?.cacheBackend)
        if (config.appConfig?.cacheBackend !== "indexeddb") return Promise.reject(new Error("Cache.add() encountered a network error"))
        config.initProgressCallback({ progress: 1, text: "done" })
        return Promise.resolve(engine)
      },
    }
    const seen: string[] = []
    const loaded = await loadWebLlm(choice, { webgpu: true, f16: true, compatOnly: false }, (p) => seen.push(p.text), async () => flaky, { stallMs: 1000, retries: 2, backoffMs: 1 })
    expect(used).toEqual(["cache", "cache", "indexeddb"])
    expect(seen.some((text) => text.includes("Switching the download store to IndexedDB"))).toBe(true)
    expect(textOf(await Effect.runPromise(stream(loaded, "hello")))).toBe("ok")
  })

  test("probeGpu gives up on an adapter request that never settles", async () => {
    const started = performance.now()
    const probe = await probeGpu({ navigator: { gpu: { requestAdapter: () => new Promise(() => {}) } } })
    expect(probe).toEqual({ webgpu: false, f16: false, compatOnly: false })
    expect(performance.now() - started).toBeLessThan(5000)
  }, 8000)

  test("probeGpu reports no WebGPU without navigator.gpu", async () => {
    expect(await probeGpu({ navigator: {} })).toEqual({ webgpu: false, f16: false, compatOnly: false })
  })

  test("probeGpu names the adapter and half precision when there is a standard adapter", async () => {
    const adapter = { features: { has: (n: string) => n === "shader-f16" }, info: { vendor: "amd", architecture: "rdna-2" } }
    expect(await probeGpu({ navigator: { gpu: { requestAdapter: async () => adapter } } })).toEqual({ webgpu: true, f16: true, compatOnly: false, adapter: "amd rdna-2" })
  })

  test("probeGpu tells a compatibility-only Chrome (Vulkan off) from no GPU at all", async () => {
    const compat = { features: { has: () => false } }
    const gpu = { requestAdapter: async (options?: { featureLevel?: string }) => (options?.featureLevel === "compatibility" ? compat : null) }
    const probe = await probeGpu({ navigator: { gpu } })
    expect(probe).toEqual({ webgpu: false, f16: false, compatOnly: true })
    const availability = webllmAvailability(probe)
    expect(availability.state).toBe("unavailable")
    expect(availability.state === "unavailable" && availability.reason).toContain("compatibility mode")
  })
})

describe("catalogue", () => {
  test("every WebLLM id and memory figure matches the installed library's prebuilt list", async () => {
    const real = (await import("@mlc-ai/web-llm")) as unknown as WebLlmModule
    const byId = new Map(real.prebuiltAppConfig.model_list.map((entry) => [entry.model_id, entry.vram_required_MB]))
    for (const choice of webllmChoices) {
      const spec = choice.webllm!
      expect(byId.has(spec.f16)).toBe(true)
      expect(byId.has(spec.f32)).toBe(true)
      expect(Math.round(byId.get(spec.f16) ?? 0)).toBe(Math.round(choice.memoryMB))
      expect(Math.round(byId.get(spec.f32) ?? 0)).toBe(Math.round(spec.memoryF32MB))
    }
  })
})


describe("CPU model adapter (fake worker)", () => {
  const choice = cpuChoices[0]!
  type Req = { type: string; id?: number }
  const worker = (script: (post: (message: unknown) => void, request: Req) => void) => {
    const posted: Req[] = []
    const w: WorkerLike = {
      onmessage: null,
      postMessage(message) {
        const request = message as Req
        posted.push(request)
        queueMicrotask(() => script((data) => w.onmessage?.({ data }), request))
      },
      terminate() {},
    }
    return { w, posted }
  }

  test("reports combined download progress, then loads", async () => {
    const seen: number[] = []
    const { w } = worker((post, request) => {
      if (request.type !== "load") return
      post({ type: "progress", progress: { status: "progress", file: "tokenizer.json", loaded: 1, total: 2 } })
      post({ type: "progress", progress: { status: "progress", file: "model.onnx", loaded: 5, total: 8 } })
      post({ type: "ready" })
    })
    await loadCpu(choice, (p) => seen.push(Math.round(p.fraction * 100)), () => w)
    expect(seen).toEqual([50, 60])
  })

  test("a load error rejects with its message", async () => {
    const { w } = worker((post) => post({ type: "error", message: "no network" }))
    await expect(loadCpu(choice, () => {}, () => w)).rejects.toThrow("no network")
  })

  test("streams tokens, and Stop interrupts that request by id and ends the stream", async () => {
    const { w, posted } = worker((post, request) => {
      if (request.type === "load") post({ type: "ready" })
      if (request.type === "generate") { post({ type: "token", id: request.id, text: "Hel" }); post({ type: "token", id: request.id, text: "lo" }) }
      if (request.type === "interrupt") post({ type: "done", id: request.id, tokens: 2 })
    })
    const loaded = await loadCpu(choice, () => {}, () => w)
    const running = Effect.runPromise(stream(loaded, "hi"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    loaded.interrupt()
    expect(textOf(await within(running, 500))).toBe("Hello")
    expect(posted.filter((m) => m.type === "interrupt")).toEqual([{ type: "interrupt", id: 1 }])
  })

  test("a stale reply from an interrupted request never reaches the next request", async () => {
    let late: (() => void) | undefined
    const { w } = worker((post, request) => {
      if (request.type === "load") post({ type: "ready" })
      if (request.type === "generate" && request.id === 1) { post({ type: "token", id: 1, text: "old" }); late = () => { post({ type: "token", id: 1, text: " STALE" }); post({ type: "done", id: 1, tokens: 2 }) } }
      if (request.type === "generate" && request.id === 2) { post({ type: "token", id: 2, text: "new" }); post({ type: "done", id: 2, tokens: 1 }) }
    })
    const loaded = await loadCpu(choice, () => {}, () => w)
    const first = Effect.runPromise(stream(loaded, "one"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    loaded.interrupt()
    await within(first, 500).catch(() => {})
    const second = await within(Effect.runPromise(stream(loaded, "two")), 500)
    late?.()
    expect(textOf(second)).toBe("new")
  })
})
