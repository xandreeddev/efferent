import { Schema } from "effect"
import type { Credential } from "../ports/auth-store.port.js"

/** The providers whose OAuth tokens a store can refresh: each has its token endpoint in an auth module. */
export const RefreshableProvider = Schema.Literals(["anthropic", "openai-codex"])
export type RefreshableProvider = typeof RefreshableProvider.Type

/** An OAuth subscription credential: an access token, its refresh token and its expiry (epoch ms). */
export type OAuthCredential = Extract<Credential, { readonly type: "oauth" }>
