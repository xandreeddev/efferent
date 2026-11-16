// A gateway model's id holds a "/", which the eval package refuses in a name: the candidate's name has none.
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { EvalId } from "@xandreed/evals"
import { candidateName } from "./run.ts"

describe("a candidate's name", () => {
  test("a gateway model's id becomes a name the eval package takes; a page model's stays as it is", () => {
    const decode = Schema.decodeUnknownOption(EvalId)
    expect(decode("gateway:deepseek/deepseek-v4.1-flash-1017")._tag).toBe("None")
    expect(candidateName("gateway:deepseek/deepseek-v4.1-flash-1017")).toBe("gateway:deepseek:deepseek-v4.1-flash-1017")
    expect(decode(candidateName("gateway:deepseek/deepseek-v4.1-flash-1017"))._tag).toBe("Some")
    expect(candidateName("qwen2.5-0.5b")).toBe("qwen2.5-0.5b")
  })
})
