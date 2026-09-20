import { join } from "node:path"
import { LanguageModel } from "@effect/ai"
import { Effect, Layer, Option, Schema } from "effect"
import { AgentLoop, AgentMessage, CurrentModelCallPolicy, defineAgent, definePlugin, HarnessError, SessionStore } from "@xandreed/core"
import { runLoop } from "@xandreed/plugin-agent-loop"
import { modelsPlugin } from "@xandreed/plugin-models"
import { sessionSqlitePlugin } from "@xandreed/plugin-session-sqlite"
import { XPlatform } from "./ports/x-platform.port.js"
import { BlogReader } from "./ports/blog-reader.port.js"
import { SocialWorkspace } from "./ports/social-workspace.port.js"
import { PlaywrightXPlatformLive } from "./adapters/playwright-x-platform.adapter.js"
import { AstroBlogReaderLive } from "./adapters/astro-blog-reader.adapter.js"
import { LocalSocialWorkspaceLive } from "./adapters/local-social-workspace.adapter.js"
import { socialToolkit, SocialToolkitLive } from "./usecases/socialToolkit.js"
import { socialAgentSystemPrompt } from "./prompt.js"

export const socialHostPlugin = definePlugin({
  id: "social/host", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [XPlatform, BlogReader, SocialWorkspace],
  layer: () => Layer.mergeAll(PlaywrightXPlatformLive, AstroBlogReaderLive, LocalSocialWorkspaceLive),
})
export const socialLoopPlugin = definePlugin({
  id: "social/loop", version: "1", config: Schema.Struct({ maxSteps: Schema.Int.pipe(Schema.between(1, 100)), effort: Schema.Literal("low", "medium", "high"), maxOutputTokens: Schema.Int.pipe(Schema.between(128, 16384)) }), defaults: { maxSteps: 8, effort: "medium" as const, maxOutputTokens: 2000 },
  requires: [LanguageModel.LanguageModel, XPlatform, BlogReader, SocialWorkspace, SessionStore], provides: [AgentLoop],
  layer: (config) => Layer.effect(AgentLoop, Effect.gen(function* () {
    const context = yield* Effect.context<LanguageModel.LanguageModel | XPlatform | BlogReader | SocialWorkspace>()
    const store = yield* SessionStore
    return AgentLoop.of({ run: (input) => Effect.gen(function* () {
      const prior = (yield* store.read(input.session.id, -1)).filter((event) => event.name === "messages")
      const messages = (yield* Effect.forEach(prior, (event) => Schema.decodeUnknown(Schema.Array(AgentMessage))(event.data.messages))).flat()
      const user = { role: "user" as const, content: input.prompt }
      yield* input.publish({ name: "messages", runId: input.runId, data: { messages: [user] } })
      const result = yield* runLoop({ system: input.system, messages: [...messages, user], toolkit: socialToolkit, maxSteps: config.maxSteps,
        onTail: (tail) => input.publish({ name: "messages", runId: input.runId, data: { messages: tail } }).pipe(Effect.as([] as ReadonlyArray<number>), Effect.orDie),
        onEvent: (event) => input.publish({ name: "loop.event", runId: input.runId, data: { ...event } }).pipe(Effect.asVoid, Effect.orDie),
      }).pipe(Effect.provide(SocialToolkitLive), Effect.provide(context), Effect.locally(CurrentModelCallPolicy, Option.some({ effort: config.effort, maxOutputTokens: config.maxOutputTokens })))
      return { text: result.finalText, outcome: result.outcome === "ok" ? "completed" as const : "partial" as const }
    }).pipe(Effect.mapError((error) => new HarnessError({ code: "social.run", message: String(error) }))) })
  })),
})
export const socialAgent = (workspace: string) => defineAgent({ id: "social", plugins: [sessionSqlitePlugin, modelsPlugin, socialHostPlugin, socialLoopPlugin], config: {
  version: 1, profile: "social", profiles: { social: {} }, system: socialAgentSystemPrompt(), plugins: [
    { id: "sessions", use: sessionSqlitePlugin.id, options: { path: join(workspace, ".efferent/runtime/social-sessions.db") } },
    { id: "models", use: modelsPlugin.id }, { id: "host", use: socialHostPlugin.id }, { id: "loop", use: socialLoopPlugin.id },
  ],
} })
