import { Context, type Effect } from "effect"
import type { Provider } from "../entities/Model.js"
import type { AuthError, OAuthTokens } from "./AuthStore.js"

/**
 * The coordinates for starting an OAuth subscription flow: the PKCE verifier
 * (echoed back as the `state`), the browser authorize URL, and the loopback
 * callback's port + path the driver should listen on.
 */
export interface OAuthBegin {
  readonly verifier: string
  readonly authorizeUrl: string
  readonly callbackPort: number
  readonly callbackPath: string
}

/** A `code`/`state` pair pulled out of a pasted redirect URL (or a raw code). */
export interface OAuthRedirect {
  readonly code?: string | undefined
  readonly state?: string | undefined
}

/**
 * The OAuth-subscription **protocol** as a port — PKCE + authorize URL, the
 * code↔token exchange, and redirect parsing — so the CLI's `:login` driver
 * depends only on `@efferent/core`, never on adapter internals (the per-provider
 * `anthropic.ts`/`openai.ts` helpers). The loopback callback server + the
 * browser-open stay in the driver: those are terminal edge, not protocol. This
 * port is the protocol; `AuthFlowLive` (adapters) dispatches to the existing
 * provider helpers.
 */
export class AuthFlow extends Context.Tag("@efferent/core/AuthFlow")<
  AuthFlow,
  {
    /** Whether `provider` offers OAuth subscription login (else: API key only). */
    readonly supportsOAuth: (provider: Provider) => Effect.Effect<boolean>
    /** Begin a flow: fresh PKCE + the authorize URL + the callback coordinates. */
    readonly begin: (provider: Provider) => Effect.Effect<OAuthBegin>
    /** Exchange an authorization code (with its PKCE verifier) for tokens. */
    readonly exchange: (
      provider: Provider,
      code: string,
      verifier: string,
    ) => Effect.Effect<OAuthTokens, AuthError>
    /** Parse a pasted redirect URL / raw code into its `code`/`state`. */
    readonly parseRedirect: (input: string) => Effect.Effect<OAuthRedirect>
  }
>() {}
