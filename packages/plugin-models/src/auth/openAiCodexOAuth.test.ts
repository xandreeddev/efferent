import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Base64Url } from "effect/encoding"
import { openAiCodexAccountId } from "./openAiCodexOAuth.js"

/** An unsigned token whose payload segment holds `claims` as JSON. */
const tokenWith = (claims: unknown): string => `header.${Base64Url.encode(JSON.stringify(claims))}.signature`

const AUTH_CLAIM = "https://api.openai.com/auth"

describe("openAiCodexAccountId", () => {
  test("reads the account id from the auth claim, other claims aside", () => {
    expect(openAiCodexAccountId(tokenWith({ sub: "user-1", [AUTH_CLAIM]: { chatgpt_account_id: "acct-1", plan: "pro" } })))
      .toEqual(Option.some("acct-1"))
  })

  test("an empty, mistyped or missing account id, or a payload that is no JSON object, is none", () => {
    const tokens = [
      tokenWith({ [AUTH_CLAIM]: { chatgpt_account_id: "" } }),
      tokenWith({ [AUTH_CLAIM]: { chatgpt_account_id: 7 } }),
      tokenWith({ [AUTH_CLAIM]: "acct-1" }),
      tokenWith({ [AUTH_CLAIM]: {} }),
      tokenWith({ sub: "user-1" }),
      tokenWith(["acct-1"]),
      `header.${Base64Url.encode("not json")}.signature`,
      "no-payload-segment",
    ]
    expect(tokens.map(openAiCodexAccountId)).toEqual(tokens.map(() => Option.none()))
  })
})
