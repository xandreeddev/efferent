// Chrome's built-in model (Gemini Nano) through the Prompt API. Runs on the main
// thread (the API is not available in workers). Every request makes a fresh
// session from the loop's messages, so the loop, not the session, owns history.
import { Effect } from "effect"
import type { ChatMessage, Usage } from "../prompt-map.ts"
import { deltaReader, settledParts, toChatMessages, usageOf } from "../prompt-map.ts"
import { makeBrowserModel } from "./make.ts"
import { aiError, modelStream } from "./stream.ts"
import type { Availability, LoadedModel, LoadProgress, ModelChoice } from "./types.ts"

export const chromeChoice: ModelChoice = {
  id: "chrome",
  kind: "chrome",
  label: "Chrome built-in (Gemini Nano)",
  blurb: "Google's on-device model, managed by Chrome. Desktop Chrome 148+; Chrome downloads it once and shares it across sites.",
  memoryMB: 0,
}

/** The slice of the Prompt API this adapter uses. */
export interface PromptSession {
  promptStreaming(input: string, options?: { signal?: AbortSignal }): ReadableStream<string>
  prompt(input: string, options?: { signal?: AbortSignal }): Promise<string>
  destroy(): void
}
export interface PromptApi {
  availability(options?: unknown): Promise<string>
  create(options?: {
    initialPrompts?: ReadonlyArray<ChatMessage>
    signal?: AbortSignal
    monitor?: (monitor: EventTarget) => void
    expectedInputs?: ReadonlyArray<{ type: string; languages: ReadonlyArray<string> }>
    expectedOutputs?: ReadonlyArray<{ type: string; languages: ReadonlyArray<string> }>
  }): Promise<PromptSession>
}

const languages = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] } as const

export const promptApiOf = (host: unknown = globalThis): PromptApi | undefined => {
  const api = typeof host === "object" && host !== null && "LanguageModel" in host ? (host as { LanguageModel: unknown }).LanguageModel : undefined
  // In a browser the global is a class (a function), not a plain object.
  return (typeof api === "function" || (typeof api === "object" && api !== null)) && "create" in api && "availability" in api ? (api as PromptApi) : undefined
}

export const chromeAvailability = async (api: PromptApi | undefined = promptApiOf()): Promise<Availability> => {
  if (api === undefined) return { state: "unavailable", reason: "This browser has no built-in Prompt API (needs desktop Chrome 148 or newer)." }
  try {
    const state = await api.availability(languages)
    if (state === "available") return { state: "ready" }
    if (state === "downloadable" || state === "downloading") return { state: "downloadable" }
    return { state: "unavailable", reason: "Chrome reports the on-device model as unavailable here (it needs ~22 GB free disk and a capable GPU or 16 GB RAM)." }
  } catch (error) {
    return { state: "unavailable", reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Split the loop's messages into the session's history and the last user message to prompt with. */
export const splitForPrompt = (messages: ReadonlyArray<ChatMessage>): { history: ReadonlyArray<ChatMessage>; input: string } => {
  const last = messages[messages.length - 1]
  return last !== undefined && last.role === "user"
    ? { history: messages.slice(0, -1), input: last.content }
    : { history: messages, input: "Continue." }
}

/** Must be called from a click: Chrome starts its download on the first create(). */
export const loadChrome = async (onProgress: (progress: LoadProgress) => void, api: PromptApi | undefined = promptApiOf()): Promise<LoadedModel> => {
  if (api === undefined) throw new Error("The Prompt API is not available in this browser.")
  const probe = await api.create({
    ...languages,
    monitor: (monitor) => monitor.addEventListener("downloadprogress", (event) => {
      const loaded = (event as Event & { loaded?: number }).loaded ?? 0
      onProgress({ fraction: loaded, text: `Downloading the on-device model: ${Math.round(loaded * 100)}%` })
    }),
  })
  probe.destroy()
  onProgress({ fraction: 1, text: "Ready." })

  let current: AbortController | undefined
  const sessionFor = (messages: ReadonlyArray<ChatMessage>, signal: AbortSignal) => {
    const { history, input } = splitForPrompt(messages)
    return api.create({ ...languages, ...(history.length > 0 ? { initialPrompts: history } : {}), signal }).then((session) => ({ session, input }))
  }

  const model = makeBrowserModel({
    generateText: (options) => Effect.tryPromise({
      try: async () => {
        const messages = toChatMessages(options.prompt)
        const controller = (current = new AbortController())
        const { session, input } = await sessionFor(messages, controller.signal)
        try {
          const reply = await session.prompt(input, { signal: controller.signal })
          return settledParts(reply, usageOf(messages, reply)) as never
        } finally {
          session.destroy()
        }
      },
      catch: (error) => aiError("ChromePrompt", "generateText", error),
    }),
    streamText: (options) => {
      const messages = toChatMessages(options.prompt)
      return modelStream("ChromePrompt", (sink) => {
        const controller = (current = new AbortController())
        let reply = ""
        const read = deltaReader()
        void (async () => {
          let session: PromptSession | undefined
          try {
            const made = await sessionFor(messages, controller.signal)
            session = made.session
            const reader = session.promptStreaming(made.input, { signal: controller.signal }).getReader()
            while (!controller.signal.aborted) {
              const { done, value } = await reader.read()
              if (done) break
              const fresh = read(value)
              reply += fresh
              if (fresh.length > 0) sink.push(fresh)
            }
            sink.end(usageOf(messages, reply) satisfies Usage)
          } catch (error) {
            if (controller.signal.aborted) sink.end(usageOf(messages, reply))
            else sink.fail(error)
          } finally {
            session?.destroy()
          }
        })()
        return () => controller.abort()
      }) as never
    },
  })

  return { choice: chromeChoice, model, interrupt: () => current?.abort(), dispose: () => current?.abort() }
}
