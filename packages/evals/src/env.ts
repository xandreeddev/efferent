import type { LanguageModel } from "@effect/ai"
import { Layer } from "effect"
import type {
  AuthStore,
  ContextTreeStore,
  ConversationStore,
  FileSystem,
  Http,
  SettingsStore,
  Shell,
  UtilityLlm,
  WebSearch,
} from "@efferent/sdk-core"
import {
  EnvAuthStoreLive,
  FetchHttpClientLive,
  HttpLive,
  LocalFileSystemLive,
  LocalSettingsStoreLive,
  LocalShellLive,
  ModelLive,
  UtilityLlmLive,
  WebSearchLive,
} from "@efferent/sdk-adapters"
import type { RunConfig } from "./config/RunConfig.js"
import { settingsLayerForConfig } from "./config/settingsLayer.js"
import { InMemoryConversationStoreLive } from "./support/inMemoryConversationStore.js"
import { InMemoryContextTreeStoreLive } from "./support/inMemoryContextTreeStore.js"

/**
 * The environment every suite runs in — the same ports the CLI composes in
 * `main.ts`, but with the in-memory `ConversationStore` instead of Postgres
 * (evals must run without Docker). `ModelLive` is the real multi-provider
 * router, so suites exercise the actual LLM path. `UtilityLlm` is wired in too
 * (the CLI's fast-tier helpers — auto-approval, headroom digests, titles —
 * need it; the fast-model suites call it directly).
 */
export type EvalEnv =
  | LanguageModel.LanguageModel
  | UtilityLlm
  | AuthStore
  | ConversationStore
  | ContextTreeStore
  | SettingsStore
  | FileSystem
  | Shell
  | Http
  | WebSearch

// Referenced as the SAME Layer value wherever a FileSystem is needed, so Effect
// memoises it to a single instance.
const FsLive = LocalFileSystemLive

/**
 * Model tier: the router/registry/LlmInfo bundle (`ModelLive`) plus the
 * fast-tier `UtilityLlm`, which is fed `ModelRegistry` from `ModelLive` and its
 * own `HttpClient`. `provideMerge` keeps `ModelLive`'s outputs in the result
 * AND satisfies `UtilityLlm`'s `ModelRegistry` dependency. Leftover
 * requirements: `AuthStore` + `SettingsStore` (provided at the edge).
 */
const ModelTier = UtilityLlmLive.pipe(
  Layer.provide(FetchHttpClientLive),
  Layer.provideMerge(ModelLive),
)

/** The port bundle that does NOT depend on the chosen settings/credentials. */
const PortsLive = Layer.mergeAll(
  ModelTier,
  InMemoryConversationStoreLive,
  InMemoryContextTreeStoreLive,
  FsLive,
  LocalShellLive,
  HttpLive,
  WebSearchLive.pipe(Layer.provide(FetchHttpClientLive)), // requires AuthStore (below)
)

/**
 * Build the eval environment. `config === undefined` → the default
 * (`LocalSettingsStoreLive`, honouring `EFFERENT_MODEL` / `.efferent/config.json`
 * when `run.ts` calls `settings.load`) — byte-for-byte today's behaviour. With
 * a `RunConfig`, a FIXED `SettingsStore` pins the run's models/prompt/steps so
 * the disk config can't override the chosen independent variable.
 */
export const makeEvalEnv = (config?: RunConfig): Layer.Layer<EvalEnv> => {
  const settingsLive =
    config === undefined
      ? LocalSettingsStoreLive.pipe(Layer.provide(FsLive))
      : settingsLayerForConfig(config)
  // provideMerge (not merge): feeds AuthStore + SettingsStore *into* the model
  // tier / WebSearch AND keeps SettingsStore in the output (runAgent reads it).
  const CredentialsLive = Layer.mergeAll(EnvAuthStoreLive, settingsLive)
  return PortsLive.pipe(Layer.provideMerge(CredentialsLive), Layer.orDie)
}

/** The default eval env (no pinned config) — what `bun run eval` uses. */
export const EvalEnvLive: Layer.Layer<EvalEnv> = makeEvalEnv()
