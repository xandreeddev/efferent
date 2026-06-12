import { AuthFlow } from "@efferent/core"
import { Effect, Layer } from "effect"
import {
  ANTHROPIC_CALLBACK_PORT,
  anthropicAuthorizeUrl,
  exchangeAnthropicCode,
  generatePkce,
  parseAuthorizationInput,
} from "./anthropic.js"
import { OPENAI_CALLBACK_PORT, exchangeOpenAiCode, openaiAuthorizeUrl } from "./openai.js"

/**
 * `AuthFlow` over the existing per-provider OAuth helpers — no redesign, just the
 * port boundary so the CLI's `:login` driver depends on the core port instead of
 * these adapter internals. PKCE generation + redirect parsing are shared (from
 * `anthropic.ts`); the authorize URL, callback coordinates, and token exchange
 * dispatch on provider, with anthropic the default branch (matching the historic
 * `provider === "openai" ? … : anthropic` selection).
 */
export const AuthFlowLive = Layer.succeed(
  AuthFlow,
  AuthFlow.of({
    supportsOAuth: (provider) => Effect.succeed(provider === "anthropic" || provider === "openai"),
    begin: (provider) =>
      generatePkce().pipe(
        Effect.map((pkce) =>
          provider === "openai"
            ? {
                verifier: pkce.verifier,
                authorizeUrl: openaiAuthorizeUrl(pkce),
                callbackPort: OPENAI_CALLBACK_PORT,
                callbackPath: "/auth/callback",
              }
            : {
                verifier: pkce.verifier,
                authorizeUrl: anthropicAuthorizeUrl(pkce),
                callbackPort: ANTHROPIC_CALLBACK_PORT,
                callbackPath: "/callback",
              },
        ),
      ),
    exchange: (provider, code, verifier) =>
      provider === "openai"
        ? exchangeOpenAiCode(code, verifier)
        : exchangeAnthropicCode(code, verifier),
    parseRedirect: (input) => Effect.sync(() => parseAuthorizationInput(input)),
  }),
)
