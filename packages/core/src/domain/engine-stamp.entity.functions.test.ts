import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Response } from "effect/ai"
import { ENGINE_KEY } from "./engine-stamp.entity.js"
import { responseModelOf, stampPartModel, stampResponseModel } from "./engine-stamp.entity.functions.js"

const usage = new Response.Usage({ inputTokens: { total: 5 }, outputTokens: { total: 3 } })
const text = Response.makePart("text", { text: "hi", metadata: { scripted: { itemId: "msg_1" } } })
const finish = (metadata: Response.FinishPartMetadata = {}) => Response.makePart("finish", { reason: "stop", usage, metadata })

describe("the engine's response stamp", () => {
  test("stamps the model on the finish part under the engine's key, beside the provider's metadata", () => {
    const content = [text, finish({ scripted: { signature: "s" } })]
    const stamped = stampResponseModel(content, "anthropic:claude-sonnet-4-6")
    expect(stamped[0]).toBe(text)
    expect(stamped[1]?.metadata).toEqual({ scripted: { signature: "s" }, [ENGINE_KEY]: { model: "anthropic:claude-sonnet-4-6" } })
    expect(Response.isPart(stamped[1])).toBe(true)
    expect(content[1]?.metadata).toEqual({ scripted: { signature: "s" } })
    expect(Option.getOrNull(responseModelOf(stamped))).toBe("anthropic:claude-sonnet-4-6")
  })

  test("the stream twin stamps a finish part and passes every other part through", () => {
    expect(stampPartModel(text, "openai:gpt-5")).toBe(text)
    expect(Option.getOrNull(responseModelOf([stampPartModel(finish(), "openai:gpt-5")]))).toBe("openai:gpt-5")
  })

  test("no finish part, no stamp, or one that is not a model → None", () => {
    expect(Option.isNone(responseModelOf([text]))).toBe(true)
    expect(Option.isNone(responseModelOf([text, finish()]))).toBe(true)
    expect(Option.isNone(responseModelOf([finish({ [ENGINE_KEY]: { model: "" } })]))).toBe(true)
    expect(Option.isNone(responseModelOf(stampResponseModel([text, finish()], "")))).toBe(true)
  })

  test("reads the engine's key only: a model a router kept under a key of its own is not the response's", () => {
    const other = finish({ router: { model: "opencode:kimi-k2.7-code" } })
    expect(Option.isNone(responseModelOf([other]))).toBe(true)
    expect(Option.getOrNull(responseModelOf(stampResponseModel([other], "openai:gpt-5")))).toBe("openai:gpt-5")
  })
})
