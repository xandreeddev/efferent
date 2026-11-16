// The gateway's key is kept in memory and the tab's storage alone, and the model list is the gateway's language models
// that call tools.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { forgetGatewayKey, gatewayKey, listGatewayModels, pickedGatewayModel, saveGatewayKey } from "./gateway-key.ts"
import { DEFAULT_GATEWAY_MODEL } from "./gateway.ts"

describe("the gateway's key and models", () => {
  test("a key is kept trimmed, an empty one forgets, and Forget key forgets", () => {
    saveGatewayKey("  vck_abc  ")
    expect(gatewayKey()).toEqual(Option.some("vck_abc"))
    saveGatewayKey("   ")
    expect(gatewayKey()).toEqual(Option.none())
    saveGatewayKey("vck_def")
    forgetGatewayKey()
    expect(gatewayKey()).toEqual(Option.none())
  })

  test("the model picked starts on the default", () => {
    expect(pickedGatewayModel()).toBe(DEFAULT_GATEWAY_MODEL)
  })

  test("the list holds the language models that call tools, sorted, read without a key", async () => {
    let asked = ""
    const listed = await listGatewayModels((url) => {
      asked = url
      return Promise.resolve(new Response(JSON.stringify({ data: [
        { id: "z/tools", type: "language", tags: ["tool-use"] },
        { id: "a/tools", type: "language", tags: ["reasoning", "tool-use"] },
        { id: "b/no-tools", type: "language", tags: ["reasoning"] },
        { id: "c/image", type: "image", tags: ["tool-use"] },
      ] })))
    })
    expect(asked).toBe("https://ai-gateway.vercel.sh/v1/models")
    expect(listed).toEqual(["a/tools", "z/tools"])
  })
})
