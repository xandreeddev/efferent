import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import {
  ANTHROPIC_CLIENT_ID,
  ANTHROPIC_REDIRECT_URI,
  beginAnthropicOAuth,
  generatePkce,
  parseAuthorizationInput,
} from "./anthropicOAuth.js"

describe("parseAuthorizationInput — total over every paste shape", () => {
  test("a full redirect URL", () => {
    const out = parseAuthorizationInput(
      "http://localhost:53692/callback?code=abc123&state=ver456",
    )
    expect(Option.getOrThrow(out.code)).toBe("abc123")
    expect(Option.getOrThrow(out.state)).toBe("ver456")
  })

  test("a code#state pair", () => {
    const out = parseAuthorizationInput("abc123#ver456")
    expect(Option.getOrThrow(out.code)).toBe("abc123")
    expect(Option.getOrThrow(out.state)).toBe("ver456")
  })

  test("a bare query string", () => {
    const out = parseAuthorizationInput("code=abc123&state=ver456")
    expect(Option.getOrThrow(out.code)).toBe("abc123")
    expect(Option.getOrThrow(out.state)).toBe("ver456")
  })

  test("a raw code (no state)", () => {
    const out = parseAuthorizationInput("  abc123  ")
    expect(Option.getOrThrow(out.code)).toBe("abc123")
    expect(Option.isNone(out.state)).toBe(true)
  })

  test("empty input is none/none", () => {
    const out = parseAuthorizationInput("   ")
    expect(Option.isNone(out.code)).toBe(true)
    expect(Option.isNone(out.state)).toBe(true)
  })

  test("a URL without a code is none/none", () => {
    const out = parseAuthorizationInput("http://localhost:53692/callback?error=denied")
    expect(Option.isNone(out.code)).toBe(true)
  })
})

describe("the authorize begin", () => {
  test("the URL carries the PKCE challenge, state=verifier, and the redirect", async () => {
    const begun = await Effect.runPromise(beginAnthropicOAuth)
    const url = new URL(begun.authorizeUrl)
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe(ANTHROPIC_CLIENT_ID)
    expect(url.searchParams.get("state")).toBe(begun.verifier)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).not.toBe("")
    expect(url.searchParams.get("redirect_uri")).toBe(ANTHROPIC_REDIRECT_URI)
  })

  test("the PKCE challenge IS the S256 of the verifier", async () => {
    const pkce = await Effect.runPromise(generatePkce)
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pkce.verifier)),
    )
    const expected = btoa(Array.from(digest, (b) => String.fromCharCode(b)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "")
    expect(pkce.challenge).toBe(expected)
  })
})
