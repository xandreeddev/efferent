import { Context, Data, type Effect, type Redacted } from "effect"
import type { Provider } from "../entities/Model.js"

/**
 * A stored provider credential. Either a raw API key, or an OAuth
 * subscription (Claude Pro/Max etc.) with its access/refresh tokens and an
 * absolute expiry (epoch ms). Persisted to `~/.efferent/auth.json` keyed by
 * provider — never to env, never to `config.json` (so a `/model` rewrite can't
 * clobber a credential, and vice-versa).
 */
export type Credential =
  | { readonly type: "api_key"; readonly key: string }
  | {
      readonly type: "oauth"
      readonly access: string
      readonly refresh: string
      readonly expires: number
      /** Provider-specific OAuth metadata. OpenAI ChatGPT tokens carry this. */
      readonly accountId?: string
      /** Stable local installation id for provider transports that require one. */
      readonly installationId?: string
    }
  /** Local provider (e.g. Ollama) — no key needed; optional custom base URL. */
  | { readonly type: "local"; readonly baseUrl?: string }

/** The whole credential map — one entry per configured provider. */
export type AuthData = Partial<Record<Provider, Credential>>

/** Freshly-minted OAuth tokens from an authorize/refresh exchange. */
export interface OAuthTokens {
  readonly access: string
  readonly refresh: string
  /** Absolute expiry, epoch ms. */
  readonly expires: number
  /** Provider-specific OAuth metadata. OpenAI ChatGPT tokens carry this. */
  readonly accountId?: string
  /** Stable local installation id for provider transports that require one. */
  readonly installationId?: string
}

/** Persisting a credential, or refreshing an expired OAuth token, failed. */
export class AuthError extends Data.TaggedError("AuthError")<{
  readonly provider: Provider
  readonly message: string
}> {}

/**
 * The credential store. Sourced **only** from `~/.efferent/auth.json` (written
 * by the in-app `:login` flow) — there is no env-var key reading. Read lazily:
 * the router/registry/web-search resolve a usable key per request via
 * {@link resolveKey}, which refreshes an expired OAuth token first, so a
 * credential added mid-session takes effect on the next turn with no restart.
 */
export class AuthStore extends Context.Tag("@xandreed/sdk-core/AuthStore")<
  AuthStore,
  {
    /** The full credential map — drives the `:login` provider-status tags. */
    readonly all: Effect.Effect<AuthData>
    /** The raw stored credential for a provider, if any. */
    readonly get: (p: Provider) => Effect.Effect<Credential | undefined>
    /**
     * A usable secret for the provider's API calls — the API key, or a valid
     * OAuth access token (refreshing + persisting first if it's near expiry).
     * `undefined` when the provider has no credential.
     */
    readonly resolveKey: (
      p: Provider,
    ) => Effect.Effect<Redacted.Redacted | undefined, AuthError>
    /** Store (and persist) an API-key credential for a provider. */
    readonly setApiKey: (p: Provider, key: string) => Effect.Effect<void, AuthError>
    /** Store (and persist) an OAuth-subscription credential for a provider. */
    readonly setOAuth: (
      p: Provider,
      tokens: OAuthTokens,
    ) => Effect.Effect<void, AuthError>
    /** Store (and persist) a local (no-auth) credential, optionally with a custom base URL. */
    readonly setLocal: (p: Provider, baseUrl?: string) => Effect.Effect<void, AuthError>
    /** Forget a provider's credential (`:logout`). */
    readonly remove: (p: Provider) => Effect.Effect<void, AuthError>
  }
>() {}
