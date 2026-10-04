import { LanguageModel } from "effect/ai"
import type { Response } from "effect/ai"
import { Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import { RunContext } from "@xandreed/core/ports/run-context.port"
import { AuthStore, definePlugin, EngineSettings, ModelCatalog, SettingsStore, UtilityCompletion, UtilityLlm } from "@xandreed/core"

const usage = { inputTokens: { total: 12, uncached: 12, cacheRead: 0 }, outputTokens: { total: 4 } }
const finish = { type: "finish", reason: "stop", usage } as const
export default definePlugin({
  id: "fixture/tmux-model", version: "1", config: Schema.Struct({ model: Schema.String }), defaults: { model: "" },
  provides: [LanguageModel.LanguageModel, SettingsStore, ModelCatalog, AuthStore, UtilityLlm],
  layer: ({ model }) => Layer.mergeAll(
    Layer.effect(LanguageModel.LanguageModel, LanguageModel.make({
      generateText: () => Effect.die("The tmux acceptance test must use streaming"),
      streamText: ({ prompt }) => Stream.unwrap(Effect.serviceOption(RunContext).pipe(Effect.map((run) => {
        const user = prompt.content.filter((message) => message.role === "user").at(-1)
        const text = Option.match(run, { onNone: () => user?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ") ?? "", onSome: (current) => current.userMessage.text })
        const results = prompt.content.flatMap((message) => message.role === "tool" ? message.content : []).filter((part) => part.type === "tool-result")
        const reply = (answer: string) => Stream.fromIterable([
          { type: "text-start", id: "answer" }, { type: "text-delta", id: "answer", delta: answer }, { type: "text-end", id: "answer" }, finish,
        ] satisfies ReadonlyArray<Response.StreamPartEncoded>)
        if (/^hello[!.\s]*$/i.test(text)) return reply("Hi! What would you like to work on?")
        if (text.toLowerCase().includes("missing file") && text.includes("README.md")) {
          const missing = results.find((part) => part.id === "repair-missing")
          const recovered = results.find((part) => part.id === "repair-readme")
          if (recovered !== undefined) return reply(recovered.isFailure ? "README.md could not be read." : "Recovered by reading README.md successfully.")
          if (missing !== undefined && !missing.isFailure) return reply("The requested file exists and was read successfully.")
          return Stream.fromIterable([
            { type: "tool-call", id: missing === undefined ? "repair-missing" : "repair-readme", name: "read_file", params: { path: missing === undefined ? "__smith_missing_fixture__.md" : "README.md" } },
            { ...finish, reason: "tool-calls" },
          ] satisfies ReadonlyArray<Response.StreamPartEncoded>)
        }
        const parts: ReadonlyArray<Response.StreamPartEncoded> = [
          { type: "text-start", id: "answer" }, { type: "text-delta", id: "answer", delta: text.includes("hold") ? "Waiting for cancellation" : model === "fixture:replacement" ? "replacement model answered" : "tmux answer received" },
          { type: "text-end", id: "answer" }, finish,
        ]
        if (text.includes("stream-check")) return Stream.fromIterable([
          { type: "text-start", id: "answer" },
          ...["Stable streaming prefix\n\n", ...Array.from({ length: 50 }, (_, n) => `word${n} `), "\n\n## Result\n\n", "- first item\n", "- second item\n\n", "```ts\n", "const answer = 42\n", "```\n\n", "Streaming complete"].map((delta) => ({ type: "text-delta" as const, id: "answer", delta })),
          { type: "text-end", id: "answer" }, finish,
        ] satisfies ReadonlyArray<Response.StreamPartEncoded>).pipe(Stream.schedule(Schedule.spaced("60 millis")))
        if (text.includes("hold")) return Stream.concat(Stream.fromIterable(parts.slice(0, 2)), Stream.never)
        if (text.includes("verify-check") && !prompt.content.some((message) => message.role === "tool" && JSON.stringify(message).includes("verify-test"))) return Stream.fromIterable([
          { type: "tool-call", id: "verify-test", name: "verify", params: { command: "printf tmux-check-ok" } },
          { ...finish, reason: "tool-calls" },
        ] satisfies ReadonlyArray<Response.StreamPartEncoded>)
        if (text.includes("tool-check") && !prompt.content.some((message) => message.role === "tool" && JSON.stringify(message).includes("read-test"))) return Stream.fromIterable([
          { type: "tool-call", id: "read-test", name: "read_file", params: { path: "README.md" } },
          { ...finish, reason: "tool-calls" },
        ] satisfies ReadonlyArray<Response.StreamPartEncoded>)
        return Stream.fromIterable(parts).pipe(Stream.schedule(Schedule.spaced("20 millis")), Stream.tap(() => Effect.logWarning("TMUX_LOG_MUST_NOT_REACH_SCREEN")))
      }))),
    })),
    Layer.succeed(SettingsStore, { load: Effect.succeed(new EngineSettings({ model: model ? Option.some(model) : Option.none() })), set: () => Effect.void, setRole: () => Effect.void }),
    Layer.succeed(ModelCatalog, { list: Effect.succeed(Array.from({ length: 30 }, (_, n) => ({ selection: `fixture:model-${n}`, provider: "fixture", credential: "local" as const }))) }),
    Layer.succeed(AuthStore, { all: Effect.succeed(new Map()), get: () => Effect.succeedNone, resolveKey: () => Effect.succeedNone, set: () => Effect.void, remove: () => Effect.void }),
    Layer.succeed(UtilityLlm, { complete: () => Effect.succeed(new UtilityCompletion({ text: "summary", usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, cacheReadTokens: 0 } })) }),
  ),
})
