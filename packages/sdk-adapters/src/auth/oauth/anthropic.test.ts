import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import {
  ANTHROPIC_CLIENT_ID,
  ANTHROPIC_REDIRECT_URI,
  anthropicAuthorizeUrl,
  generatePkce,
  parseAuthorizationInput,
} from "./anthropic.js"

describe("anthropic OAuth protocol", () => {
  it("builds an authorize URL with PKCE + state = verifier", async () => {
    const pkce = await Effect.runPromise(generatePkce())
    const url = new URL(anthropicAuthorizeUrl(pkce))
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe(ANTHROPIC_CLIENT_ID)
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("redirect_uri")).toBe(ANTHROPIC_REDIRECT_URI)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge)
    expect(url.searchParams.get("state")).toBe(pkce.verifier)
  })

  it("generates a base64url verifier + a distinct S256 challenge", async () => {
    const a = await Effect.runPromise(generatePkce())
    const b = await Effect.runPromise(generatePkce())
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.challenge).not.toBe(a.verifier)
    expect(a.verifier).not.toBe(b.verifier) // random per call
  })

  it("parses code/state from a redirect URL", () => {
    expect(
      parseAuthorizationInput("http://localhost:53692/callback?code=abc&state=xyz"),
    ).toEqual({ code: "abc", state: "xyz" })
  })

  it("parses a raw code#state and a bare code", () => {
    expect(parseAuthorizationInput("abc#xyz")).toEqual({ code: "abc", state: "xyz" })
    expect(parseAuthorizationInput("just-a-code")).toEqual({ code: "just-a-code" })
  })
})
