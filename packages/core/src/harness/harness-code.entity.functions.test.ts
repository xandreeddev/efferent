import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { AttachmentRejected } from "../domain/media.entity.js"
import { ConversationId } from "../domain/message.entity.js"
import { RunId } from "../domain/run.entity.js"
import { SessionLogError, SessionMissing } from "../session/session-log.entity.js"
import {
  KeyConflict,
  NothingPending,
  NotResumable,
  ReservedKind,
  RunIdReused,
  SessionBusy,
  SessionContended,
  TurnClosed,
  turnBeginCodes,
  TurnDuplicate,
  TurnRefused,
} from "../session/sessions.entity.js"
import { HARNESS_CODES, HarnessCode, TAGGED_CODES } from "./harness-code.entity.js"
import { harnessCodeOf, harnessError } from "./harness-code.entity.functions.js"
import { HarnessError } from "./plugin.entity.js"
import { isHarnessError } from "./plugin.entity.functions.js"

const session = ConversationId.make("00000000-0000-4000-8000-0000000000a1")

/** A tagged error of another package's with a code of its own, as the models plugin's `AuthError` carries `auth.corrupt`. */
class StoreUnreadable extends Schema.TaggedError<StoreUnreadable>()("StoreUnreadable", {
  message: Schema.String,
  code: Schema.optionalKey(Schema.Literal("auth.corrupt")),
}) {}

/** One of each tagged error `TAGGED_CODES` names, as the framework raises it. */
const tagged = [
  new AttachmentRejected({ reason: "Empty", message: "no bytes" }),
  new SessionBusy({ session, turn: 2 }),
  new TurnDuplicate({ session, turn: 2, open: true }),
  new KeyConflict({ session, key: "k", turn: 2 }),
  new RunIdReused({ session, runId: RunId.make("r"), turn: 2 }),
  new NothingPending({ session }),
  new NotResumable({ session, turn: 2, reason: "finished" }),
  new TurnRefused({ session, reason: "quota", message: "over quota" }),
  new SessionMissing({ session }),
  new SessionContended({ session, attempts: 5 }),
  new SessionLogError({ code: "store.busy", message: "the database is locked" }),
  new TurnClosed({ session, turn: 2, reason: "cancelled" }),
  new ReservedKind({ kind: "turn.ended" }),
]

describe("harnessCodeOf", () => {
  test("a HarnessError gives its own code, with a cause or without", () => {
    expect(harnessCodeOf(new HarnessError({ code: "config.graph", message: "a cycle" }))).toEqual(Option.some("config.graph"))
    expect(harnessCodeOf(new HarnessError({ code: "host.own", message: "a host's", cause: new Error("under it") }))).toEqual(Option.some("host.own"))
  })

  test("each of the framework's tagged errors gives the code its tag stands for, a SessionLogError's own code aside", () => {
    expect(tagged.map((error): string => error._tag).toSorted()).toEqual(Object.keys(TAGGED_CODES).toSorted())
    expect(tagged.map((error) => [error._tag, harnessCodeOf(error)])).toEqual(tagged.map((error) => [error._tag, Option.some(TAGGED_CODES[error._tag])]))
    expect(harnessCodeOf(new SessionBusy({ session, turn: 1 }))).toEqual(Option.some("session.busy"))
    expect(harnessCodeOf(new TurnClosed({ session, turn: 1, reason: "removed" }))).toEqual(Option.some("turn.closed"))
    expect(harnessCodeOf(new SessionLogError({ code: "store.io", message: "disk full" }))).toEqual(Option.some("session.log"))
  })

  test("a tagged error from another copy of core, a plain object of the same tag and fields, gives the same code", () => {
    expect(tagged.map((error) => harnessCodeOf({ ...error, _tag: error._tag }))).toEqual(tagged.map((error) => harnessCodeOf(error)))
    expect(harnessCodeOf({ _tag: "SessionBusy" })).toEqual(Option.some("session.busy"))
    expect(harnessCodeOf({ _tag: "HarnessError", code: "events.depth", message: "too deep" })).toEqual(Option.some("events.depth"))
  })

  test("another tagged error gives its own string code", () => {
    expect(harnessCodeOf(new StoreUnreadable({ message: "unreadable", code: "auth.corrupt" }))).toEqual(Option.some("auth.corrupt"))
    expect(harnessCodeOf(new StoreUnreadable({ message: "no key" }))).toEqual(Option.none())
  })

  test("an untagged value gives none, whatever code it carries", () => {
    expect(harnessCodeOf({ code: "ENOENT", message: "no such file" })).toEqual(Option.none())
    expect(harnessCodeOf(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }))).toEqual(Option.none())
    expect(harnessCodeOf(new Error("boom"))).toEqual(Option.none())
    expect([harnessCodeOf("text"), harnessCodeOf(undefined), harnessCodeOf({ _tag: "toString" })]).toEqual([Option.none(), Option.none(), Option.none()])
  })
})

describe("harnessError", () => {
  test("keeps its cause only when given one, and is a HarnessError either way", () => {
    const cause = new Error("the socket closed")
    const withCause = harnessError("loop.failed", "the model call failed", cause)
    const without = harnessError("loop.model", "no LanguageModel")
    expect([withCause.code, withCause.message, withCause.cause]).toEqual(["loop.failed", "the model call failed", cause])
    expect("cause" in without).toBe(false)
    expect([isHarnessError(withCause), isHarnessError(without)]).toEqual([true, true])
    expect(isHarnessError({ _tag: "HarnessError", code: "x.y", message: "m", cause: { anything: 1 } })).toBe(true)
  })

  test("encodes its cause as name and message, never its stack", () => {
    const encoded = Schema.encodeUnknownSync(HarnessError)(harnessError("plugin.activation", "the layer failed", new TypeError("x is not a function")))
    expect(encoded).toEqual({ _tag: "HarnessError", code: "plugin.activation", message: "the layer failed", cause: { name: "TypeError", message: "x is not a function" } })
  })
})

describe("HARNESS_CODES", () => {
  test("lists each code once, every tagged error's and every begin code among them", () => {
    expect(new Set(HARNESS_CODES).size).toBe(HARNESS_CODES.length)
    expect(HARNESS_CODES.toSorted()).toEqual([...HARNESS_CODES])
    expect([...Object.values(TAGGED_CODES), ...Object.values(turnBeginCodes)].filter((code) => !Schema.is(HarnessCode)(code))).toEqual([])
  })
})
