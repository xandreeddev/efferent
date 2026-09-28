import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { UserMessage } from "../turn/user-message.entity.js"
import { buildContext, canonicalJson, encodeAppend, entriesOfPayload, fingerprintOf } from "./memory-log.entity.functions.js"
import { LogBody, LogEntry } from "./memory-log.entity.js"

/** A TurnStarted entry exactly as earlier releases stored it: the user's message under `prompt`. */
const legacyEntry = { id: "run-1:0", runId: "run-1", turn: 1, step: 0, at: 1_700_000_000_000, body: { _tag: "TurnStarted", prompt: "hi" } }
const legacyPayload = { v: 2, entries: canonicalJson([legacyEntry]) }

describe("the memory log's TurnStarted entry", () => {
  test("a legacy entry decodes to a UserMessage and re-encodes to the same canonical bytes", async () => {
    const body = Schema.decodeUnknownSync(LogBody)({ _tag: "TurnStarted", prompt: "hi" })
    expect(body._tag).toBe("TurnStarted")
    if (body._tag !== "TurnStarted") return
    expect(body.userMessage).toBeInstanceOf(UserMessage)
    expect(body.userMessage.text).toBe("hi")
    expect(canonicalJson(Schema.encodeSync(LogBody)(body))).toBe(canonicalJson({ _tag: "TurnStarted", prompt: "hi" }))

    const entries = await Effect.runPromise(entriesOfPayload(legacyPayload))
    const again = await Effect.runPromise(encodeAppend(entries))
    expect(again.entries).toBe(legacyPayload.entries)
  })

  test("a new entry is stored under the original key, so fingerprints do not move", async () => {
    const entry: LogEntry = { ...Schema.decodeUnknownSync(LogEntry)(legacyEntry), body: { _tag: "TurnStarted", userMessage: new UserMessage({ text: "hi" }) } }
    const payload = await Effect.runPromise(encodeAppend([entry]))
    expect(payload.entries).toBe(legacyPayload.entries)
    expect(payload.entries).not.toContain("userMessage")
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
