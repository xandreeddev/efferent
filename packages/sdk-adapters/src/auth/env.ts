import {
  AuthError,
  AuthStore,
  type AuthData,
  type Credential,
  type Provider,
} from "@xandreed/sdk-core"
import { Config, Effect, Layer, Option, Redacted } from "effect"

/**
 * An `AuthStore` backed by the provider API-key env vars — for **headless**
 * contexts (evals / CI) where the interactive `:login` flow can't run. The
 * product CLI uses {@link LocalAuthStoreLive} (`~/.efferent/auth.json`) and
 * reads no env. This adapter is read-only: the setters fail, since there's no
 * file to persist to.
 */

// Ollama is local-only and has no env-var key; it's omitted from this map.
const ENV_VAR: Partial<Record<Provider, string>> = {
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  opencode: "OPENCODE_API_KEY",
}

const readEnvKey = (name: string): Effect.Effect<string | undefined> =>
  Config.option(Config.redacted(name)).pipe(
    Effect.map(Option.map(Redacted.value)),
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  )

export const EnvAuthStoreLive = Layer.effect(
  AuthStore,
  Effect.gen(function* () {
    const data: Record<string, Credential> = {}
    for (const [p, envVar] of Object.entries(ENV_VAR) as [Provider, string][]) {
      const k = yield* readEnvKey(envVar)
      if (k !== undefined) data[p] = { type: "api_key", key: k }
    }
    const snapshot = data as AuthData

    const readOnly = (provider: Provider) =>
      Effect.fail(
        new AuthError({
          provider,
          message: "env-backed AuthStore is read-only (set the env var instead)",
        }),
      )

    return AuthStore.of({
      all: Effect.succeed(snapshot),
      get: (p) => Effect.succeed(snapshot[p]),
      resolveKey: (p) =>
        Effect.succeed(
          snapshot[p]?.type === "api_key"
            ? Redacted.make((snapshot[p] as { key: string }).key)
            : undefined,
        ),
      setApiKey: (p) => readOnly(p),
      setOAuth: (p) => readOnly(p),
      setLocal: (p) => readOnly(p),
      remove: (p) => readOnly(p),
    })
  }),
)
