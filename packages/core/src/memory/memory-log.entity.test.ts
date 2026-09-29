import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { UserMessage } from "../turn/user-message.entity.js"
import { buildContext, canonicalJson, fingerprintOf } from "./memory-log.entity.functions.js"
import { LogBody, LogEntry } from "./memory-log.entity.js"

/** A TurnStarted entry exactly as earlier releases stored it: the user's message under `prompt`. */
const legacyEntry = { id: "run-1:0", runId: "run-1", turn: 1, step: 0, at: 1_700_000_000_000, body: { _tag: "TurnStarted", prompt: "hi" } }

describe("the memory log's TurnStarted entry", () => {
  test("a legacy entry decodes to a UserMessage and re-encodes to the same canonical bytes", async () => {
    const body = Schema.decodeUnknownSync(LogBody)({ _tag: "TurnStarted", prompt: "hi" })
    expect(body._tag).toBe("TurnStarted")
    if (body._tag !== "TurnStarted") return
    expect(body.userMessage).toBeInstanceOf(UserMessage)
    expect(body.userMessage.text).toBe("hi")
    expect(canonicalJson(Schema.encodeSync(LogBody)(body))).toBe(canonicalJson({ _tag: "TurnStarted", prompt: "hi" }))
    expect(canonicalJson(Schema.encodeSync(LogEntry)(Schema.decodeUnknownSync(LogEntry)(legacyEntry)))).toBe(canonicalJson(legacyEntry))
  })

  test("a new entry encodes under the original key, so fingerprints do not move", async () => {
    const entry: LogEntry = { ...Schema.decodeUnknownSync(LogEntry)(legacyEntry), body: { _tag: "TurnStarted", userMessage: new UserMessage({ text: "hi" }) } }
    const encoded = canonicalJson(Schema.encodeSync(LogEntry)(entry))
    expect(encoded).toBe(canonicalJson(legacyEntry))
    expect(encoded).not.toContain("userMessage")
    const built = buildContext([entry], {
      strategy: "test", currentTurn: 1, currentRun: "run-1", turnContext: "current", replies: true,
      stepContext: "tail", digests: false, media: { mode: "none", maxImages: 0 },
    })
    expect(built.messages).toEqual([{ role: "user", content: "hi" }])
    expect(built.fingerprint).toBe(fingerprintOf(canonicalJson([{ role: "user", content: "hi" }])))
  })

  test("a user message is never blank", () => {
    expect(Option.isNone(Schema.decodeUnknownOption(LogBody)({ _tag: "TurnStarted", prompt: "" }))).toBe(true)
  })
})
