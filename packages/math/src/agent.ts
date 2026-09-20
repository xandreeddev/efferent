import { join } from "node:path"
import { LanguageModel } from "@effect/ai"
import { Effect, Layer, Option, Schema } from "effect"
import { AgentLoop, AgentMessage, HarnessError, SessionStore, ConversationStore, defineAgent, definePlugin, SessionEnvironment } from "@xandreed/core"
import { domainLoop } from "@xandreed/sdk"
import { modelsPlugin } from "@xandreed/plugin-models"
import { sessionSqlitePlugin, SqliteConversationStoreLive } from "@xandreed/plugin-session-sqlite"
import { makeMathSession } from "./session.js"

export const mathStorePlugin = definePlugin({
  id: "math/conversations", version: "1", scope: "runtime", config: Schema.Struct({ file: Schema.String }), defaults: { file: ".efferent/runtime/math.db" },
  requires: [SessionEnvironment], provides: [ConversationStore],
  layer: ({ file }) => Layer.unwrapEffect(SessionEnvironment.pipe(Effect.map(({ workspace }) => SqliteConversationStoreLive(join(workspace, file))))),
})
export const mathLoopPlugin = definePlugin({
  id: "math/loop", version: "1", config: Schema.Struct({}), defaults: {},
  requires: [LanguageModel.LanguageModel, ConversationStore, SessionEnvironment, SessionStore], provides: [AgentLoop],
  layer: () => Layer.scoped(AgentLoop, Effect.gen(function* () {
    const { workspace } = yield* SessionEnvironment
    const store = yield* ConversationStore
    const mapError = (error: unknown) => new HarnessError({ code: "math.snapshot", message: String(error) })
    return yield* domainLoop({
      snapshot: (id) => store.list(id).pipe(Effect.map((messages) => ({ messages })), Effect.mapError(mapError)),
      restore: (id, data) => store.list(id).pipe(Effect.flatMap((existing) => existing.length > 0 ? Effect.void : Schema.decodeUnknown(Schema.Array(AgentMessage))(data.messages).pipe(Effect.flatMap((messages) => store.appendAll(id, messages)), Effect.asVoid)), Effect.mapError(mapError)),
      create: (conversationId) => makeMathSession({ conversationId, cwd: workspace }), result: (event) => event.type === "agent_end" ? Option.some({ text: event.finalText, outcome: event.outcome === "ok" ? "completed" : "partial" }) : Option.none() })
  })),
})
export const mathAgent = (workspace: string) => defineAgent({ id: "math", plugins: [sessionSqlitePlugin, modelsPlugin, mathStorePlugin, mathLoopPlugin], config: {
  version: 1, profile: "math", profiles: { math: {} }, plugins: [
    { id: "sessions", use: sessionSqlitePlugin.id, options: { path: join(workspace, ".efferent/runtime/math-sessions.db") } },
    { id: "models", use: modelsPlugin.id }, { id: "conversations", use: mathStorePlugin.id }, { id: "loop", use: mathLoopPlugin.id },
  ],
} })
