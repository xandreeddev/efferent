import { join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { AgentLoop, HarnessError, SessionStore, AuthStore, ConversationStore, defineAgent, definePlugin, SessionEnvironment, SettingsStore } from "@xandreed/core"
import { domainLoop } from "@xandreed/sdk"
import { modelsPlugin } from "@xandreed/plugin-models"
import { sessionSqlitePlugin, SqliteConversationStoreLive } from "@xandreed/plugin-session-sqlite"
import { makeUiAgentSession, UiAgentExecutionProfile, UiAgentModels, UiAgentProfile, UiComponentCatalog, UiHost, UiPageEvent, UiPageStore, UiThemeStore } from "@xandreed/ui-agent"
import profileJson from "@xandreed/ui-agent/profiles/streaming-ui-v1"
import { DefaultUiHostLive } from "./adapters/default-ui-host.adapter.js"
import { SqliteUiPageStoreLive } from "./adapters/sqlite-ui-page-store.adapter.js"
import { SqliteUiComponentCatalogLive } from "./adapters/sqlite-ui-component-catalog.adapter.js"
import { SqliteUiThemeStoreLive } from "./adapters/sqlite-ui-theme-store.adapter.js"
import { uiAgentRuntimeLive } from "./adapters/ui-agent-runtime.adapter.js"

export const canvasHostPlugin = definePlugin({
  id: "canvas/host", version: "1", scope: "runtime", config: Schema.Struct({ file: Schema.String }), defaults: { file: ".efferent/runtime/canvas.db" },
  requires: [SessionEnvironment], provides: [ConversationStore, UiPageStore, UiComponentCatalog, UiThemeStore, UiHost],
  layer: ({ file }) => Layer.unwrapEffect(SessionEnvironment.pipe(Effect.map(({ workspace }) => {
    const path = join(workspace, file)
    return Layer.mergeAll(SqliteConversationStoreLive(path), SqliteUiPageStoreLive(path), SqliteUiComponentCatalogLive(path), SqliteUiThemeStoreLive(path), DefaultUiHostLive)
  }))),
})
export const canvasProfilePlugin = definePlugin({
  id: "canvas/profile", version: "1", config: Schema.Struct({ profile: UiAgentProfile }), defaults: { profile: profileJson as typeof UiAgentProfile.Type },
  requires: [AuthStore, SettingsStore], provides: [UiAgentExecutionProfile, UiAgentModels], layer: ({ profile }) => uiAgentRuntimeLive(profile),
})
export const canvasLoopPlugin = definePlugin({
  id: "canvas/loop", version: "1", config: Schema.Struct({}), defaults: {},
  requires: [ConversationStore, UiPageStore, UiHost, UiAgentModels, UiAgentExecutionProfile, UiComponentCatalog, UiThemeStore, SessionStore, SessionEnvironment], provides: [AgentLoop],
  layer: () => Layer.scoped(AgentLoop, Effect.gen(function* () {
    const store = yield* UiPageStore
    const mapError = (error: unknown) => new HarnessError({ code: "canvas.snapshot", message: String(error) })
    return yield* domainLoop({
      snapshot: (id) => store.list(id).pipe(Effect.map((pages) => ({ pages })), Effect.mapError(mapError)),
      restore: (id, data) => store.list(id).pipe(Effect.flatMap((existing) => existing.length > 0 ? Effect.void : Schema.decodeUnknown(Schema.Array(UiPageEvent))(data.pages).pipe(Effect.flatMap((pages) => Effect.forEach(pages, (event) => store.append(id, event), { discard: true })))), Effect.mapError(mapError)),
      create: (conversationId) => makeUiAgentSession({ conversationId, awaitCompletion: true }),
      result: (event) => event.type === "agent_end" ? Option.some({ text: event.finalText, outcome: event.outcome === "ok" ? "completed" : "partial" }) : Option.none(),
    })
  })),
})
export const canvasAgent = (workspace: string) => defineAgent({ id: "canvas", plugins: [sessionSqlitePlugin, modelsPlugin, canvasHostPlugin, canvasProfilePlugin, canvasLoopPlugin], config: {
  version: 1, profile: "canvas", profiles: { canvas: {} }, plugins: [
    { id: "sessions", use: sessionSqlitePlugin.id, options: { path: join(workspace, ".efferent/runtime/canvas-sessions.db") } },
    { id: "models", use: modelsPlugin.id }, { id: "host", use: canvasHostPlugin.id }, { id: "profile", use: canvasProfilePlugin.id }, { id: "loop", use: canvasLoopPlugin.id },
  ],
} })
