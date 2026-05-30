import type { LanguageModel } from "@effect/ai"
import { Layer } from "effect"
import type {
  ConversationStore,
  FileSystem,
  Http,
  SettingsStore,
  Shell,
  WebSearch,
} from "@agent/core"
import {
  HttpLive,
  LocalFileSystemLive,
  LocalSettingsStoreLive,
  LocalShellLive,
  ModelLive,
  ProviderClientsLive,
  WebSearchLive,
} from "@agent/adapters"
import { InMemoryConversationStoreLive } from "./support/inMemoryConversationStore.js"

/**
 * The environment every suite runs in — the same ports the CLI composes in
 * `main.ts`, but with the in-memory `ConversationStore` instead of Postgres
 * (evals must run without Docker). `ModelLive` is the real multi-provider
 * router, so suites exercise the actual LLM path.
 */
export type EvalEnv =
  | LanguageModel.LanguageModel
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

export const EvalEnvLive: Layer.Layer<EvalEnv> = Layer.mergeAll(
  ModelLive, // requires SettingsStore
  InMemoryConversationStoreLive,
  FsLive,
  LocalShellLive,
  HttpLive,
  WebSearchLive.pipe(Layer.provide(ProviderClientsLive)),
).pipe(
  // provideMerge (not merge): feeds SettingsStore *into* ModelLive AND keeps
  // it in the output (runAgent reads it for maxSteps). Mirrors main.ts.
  Layer.provideMerge(SettingsLive),
  // The provider clients read keys via Config (optional); a genuinely broken
  // config is unrecoverable for an eval run, so surface it as a defect.
  Layer.orDie,
)
