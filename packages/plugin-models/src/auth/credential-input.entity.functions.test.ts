import { describe, expect, test } from "bun:test"
import { Effect, Redacted } from "effect"
import type { Credential } from "../ports/auth-store.port.js"
import { AccountId, InstallationId } from "./credential-input.entity.js"
import type { CredentialInput } from "./credential-input.entity.js"
import { credentialsOf, encodeCredential, toCredentialInput } from "./credential-input.entity.functions.js"

describe("a credential a host hands over is the credential the store keeps", () => {
  test("a handed-over credential is stored as it is", () => {
    const stored = (input: CredentialInput): Credential => input
    const input: CredentialInput = { type: "api_key", key: Redacted.make("sk-handed") }
    expect(stored(input)).toBe(input)
  })

  test("toCredentialInput hands back the same Redacted secrets, the OAuth ids branded", () => {
    const access = Redacted.make("at")
    const refresh = Redacted.make("rt")
    const key = Redacted.make("sk-held")
    const oauth: Credential = { type: "oauth", access, refresh, expires: 1, accountId: "acct", installationId: "inst" }
    const apiKey: Credential = { type: "api_key", key }
    const local: Credential = { type: "local" }
    const handed: CredentialInput = toCredentialInput(oauth)
    expect(handed).toEqual({ type: "oauth", access, refresh, expires: 1, accountId: AccountId.make("acct"), installationId: InstallationId.make("inst") })
    const [heldAccess, heldRefresh] = handed.type === "oauth" ? [handed.access, handed.refresh] : []
    expect(heldAccess).toBe(access)
    expect(heldRefresh).toBe(refresh)
    expect(toCredentialInput(apiKey)).toBe(apiKey)
    expect(toCredentialInput(local)).toBe(local)
  })

  test("credentialsOf keeps each value and its Redacted secrets", () => {
    const oauth: CredentialInput = { type: "oauth", access: Redacted.make("at"), refresh: Redacted.make("rt"), expires: 1, accountId: AccountId.make("acct") }
    const all = credentialsOf({ anthropic: oauth, ollama: { type: "local" } })
    expect([...all.keys()]).toEqual(["anthropic", "ollama"])
    expect(all.get("anthropic")).toBe(oauth)
  })
})

describe("encodeCredential", () => {
  test("gives the stored form, secrets in the clear and optional fields only when set", async () => {
    const encoded = await Effect.runPromise(Effect.all([
      encodeCredential("opencode", { type: "api_key", key: Redacted.make("sk-key") }),
      encodeCredential("openai-codex", { type: "oauth", access: Redacted.make("at"), refresh: Redacted.make("rt"), expires: 1, accountId: "acct" }),
      encodeCredential("ollama", { type: "local" }),
    ], { concurrency: 1 }))
    expect(encoded).toEqual([
      { type: "api_key", key: "sk-key" },
      { type: "oauth", access: "at", refresh: "rt", expires: 1, accountId: "acct" },
      { type: "local" },
    ])
  })

  test("a secret that is not Redacted fails with an AuthError naming the provider, never the value", async () => {
    const untyped = (credential: unknown): Credential => credential as never
    const failure = await Effect.runPromise(Effect.flip(encodeCredential("openai", untyped({ type: "api_key", key: "sk-plain-secret" }))))
    expect([failure._tag, failure.provider]).toEqual(["AuthError", "openai"])
    expect(`${failure.message} ${JSON.stringify(failure)} ${String(failure)}`).not.toContain("sk-plain-secret")
  })
})
