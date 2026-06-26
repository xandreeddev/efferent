import { LanguageModel } from "@effect/ai"
import { Effect, Layer } from "effect"
import {
  type AuthStore,
  type ContextTreeStore,
  type ConversationStore,
  type FileSystem,
  type Http,
  selectionFromString,
  type SettingsStore,
  type Shell,
  type UtilityLlm,
  type WebSearch,
} from "@xandreed/sdk-core"
import {
  EnvAuthStoreLive,
  FetchHttpClientLive,
  HttpLive,
  LocalAuthStoreLive,
  LocalFileSystemLive,
  LocalSettingsStoreLive,
  LocalShellLive,
  makePinnedModel,
  ModelLive,
  UtilityLlmLive,
  WebSearchLive,
} from "@xandreed/sdk-adapters"
import type { RunConfig } from "./config/RunConfig.js"
import { settingsLayerForConfig } from "./config/settingsLayer.js"
import { JudgeModel } from "./framework/judge.js"
import { InMemoryConversationStoreLive } from "./support/inMemoryConversationStore.js"
import { InMemoryContextTreeStoreLive } from "./support/inMemoryContextTreeStore.js"

/**
 * The environment every suite runs in — the same ports the CLI composes in
 * `main.ts`, but with the in-memory `ConversationStore` instead of Postgres
 * (evals must run without Docker). `ModelLive` is the real multi-provider
 * router, so suites exercise the actual LLM path. `UtilityLlm` is wired in too
 * (the CLI's fast-tier helpers — auto-approval, compaction digests, titles —
 * need it; the fast-model suites call it directly).
 */
export type EvalEnv =
  | LanguageModel.LanguageModel
  | JudgeModel
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
/** Provider key env vars (mirrors adapters/auth/env.ts). When ANY is set we're
 *  in CI / a key-injected run → read env (`EnvAuthStoreLive`). When none is set
 *  → fall back to the user's `~/.efferent/auth.json` (`LocalAuthStoreLive`) so a
 *  LOCAL `bun run eval` "just works" with logged-in creds (no export needed) —
 *  which is what makes a real baseline runnable on a dev machine. */
const ENV_KEY_VARS = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENCODE_API_KEY",
] as const
const hasEnvKey = (): boolean => ENV_KEY_VARS.some((v) => (process.env[v] ?? "").length > 0)

/**
 * The judge model — a strong, INDEPENDENT grader pinned to `--judge` when set,
 * else the main model (today's behaviour). Built once per env (the eval run's
 * lifetime, `Layer.scoped`); a judge-key/build failure degrades to the main
 * model rather than aborting the run. Resolves LanguageModel/Auth/Settings from
 * the base env; brings its own HttpClient.
 */
const JudgeModelLive = (
  config?: RunConfig,
): Layer.Layer<JudgeModel, never, LanguageModel.LanguageModel | AuthStore | SettingsStore> =>
  Layer.scoped(
    JudgeModel,
    Effect.gen(function* () {
      const main = yield* LanguageModel.LanguageModel
      if (config?.judge === undefined) return main
      return yield* makePinnedModel(selectionFromString(config.judge)).pipe(
        Effect.orElseSucceed(() => main),
      )
    }),
  ).pipe(Layer.provide(FetchHttpClientLive))

export const makeEvalEnv = (config?: RunConfig): Layer.Layer<EvalEnv> => {
  const settingsLive =
    config === undefined
      ? LocalSettingsStoreLive.pipe(Layer.provide(FsLive))
      : settingsLayerForConfig(config)
  const authLive = hasEnvKey() ? EnvAuthStoreLive : LocalAuthStoreLive
  // provideMerge (not merge): feeds AuthStore + SettingsStore *into* the model
  // tier / WebSearch AND keeps SettingsStore in the output (runAgent reads it).
  const CredentialsLive = Layer.mergeAll(authLive, settingsLive)
  const base = PortsLive.pipe(Layer.provideMerge(CredentialsLive))
  // JudgeModel sits on top — it needs LanguageModel + Auth + Settings from base.
  return JudgeModelLive(config).pipe(Layer.provideMerge(base), Layer.orDie)
}

/** The default eval env (no pinned config) — what `bun run eval` uses. */
export const EvalEnvLive: Layer.Layer<EvalEnv> = makeEvalEnv()
