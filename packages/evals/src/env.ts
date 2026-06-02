import type { LanguageModel } from "@effect/ai"
import { Layer } from "effect"
import type {
  AuthStore,
  ConversationStore,
  FileSystem,
  Http,
  SettingsStore,
  Shell,
  WebSearch,
} from "@efferent/core"
import {
  EnvAuthStoreLive,
  FetchHttpClientLive,
  HttpLive,
  LocalFileSystemLive,
  LocalSettingsStoreLive,
  LocalShellLive,
  ModelLive,
  WebSearchLive,
} from "@efferent/adapters"
import { InMemoryConversationStoreLive } from "./support/inMemoryConversationStore.js"

/**
 * The environment every suite runs in — the same ports the CLI composes in
 * `main.ts`, but with the in-memory `ConversationStore` instead of Postgres
 * (evals must run without Docker). `ModelLive` is the real multi-provider
 * router, so suites exercise the actual LLM path.
 */
export type EvalEnv =
  | LanguageModel.LanguageModel
  | AuthStore
  | ConversationStore
  | SettingsStore
  | FileSystem
  | Shell
  | Http
  | WebSearch

// Referenced in two places (the bundle and SettingsLive) as the SAME Layer
// value, so Effect memoises it to a single FileSystem instance.
const FsLive = LocalFileSystemLive
const SettingsLive = LocalSettingsStoreLive.pipe(Layer.provide(FsLive))
// Headless credentials: read the provider keys from the env (the product CLI
// uses auth.json via :login; evals/CI can't run the interactive flow).
const CredentialsLive = Layer.mergeAll(EnvAuthStoreLive, SettingsLive)

export const EvalEnvLive: Layer.Layer<EvalEnv> = Layer.mergeAll(
  ModelLive, // requires AuthStore + SettingsStore
  InMemoryConversationStoreLive,
  FsLive,
  LocalShellLive,
  HttpLive,
  WebSearchLive.pipe(Layer.provide(FetchHttpClientLive)), // requires AuthStore (below)
).pipe(
  // provideMerge (not merge): feeds AuthStore + SettingsStore *into* ModelLive
  // / WebSearchLive AND keeps SettingsStore in the output (runAgent reads it
  // for maxSteps). Mirrors main.ts.
  Layer.provideMerge(CredentialsLive),
  Layer.orDie,
)
