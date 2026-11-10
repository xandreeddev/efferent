import { Effect, Predicate, Schema } from "effect"
import { JsonObject } from "./session-log.entity.js"
import type { RevisionConflict, SessionHead, SessionRef, SessionLogError } from "./session-log.entity.js"

/** Any value written out as JSON text: `undefined` fields are dropped, as a store drops them. */
const toText = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
/** The text read back, decoded: it must be a JSON object. */
const fromText = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonObject))

/**
 * A JSON object as a store gives it back: written as JSON text and read
 * again. It is a copy, with `undefined` fields dropped, so a log in memory
 * returns from a commit what a later read (or a store on disk) does. It
 * takes any object, so a draft whose encoded form holds `unknown` values
 * (a tool's input, a schema's parameters) becomes a `JsonObject` through
 * it. A value JSON cannot hold (a BigInt, a cycle) fails with the
 * SchemaError.
 */
export const storedJson = (value: Readonly<Record<string, unknown>>): Effect.Effect<JsonObject, Schema.SchemaError> =>
  toText(value).pipe(Effect.flatMap(fromText))

/** Whether the store was too busy to answer (`store.busy`: another connection held it): nothing was written, and a retry may succeed. */
export const isStoreBusy = (error: SessionLogError): boolean => error.code === "store.busy"

/**
 * Whether a failure is a `RevisionConflict` (by its tag, whichever copy of
 * `@xandreed/core` made it): the head moved on and nothing was written, so a
 * compare-and-swap reads the head again and retries at once.
 */
export const isRevisionConflict = (error: unknown): error is RevisionConflict => Predicate.isTagged(error, "RevisionConflict")

/** Capture a head's exact owner and incarnation for data operations. @public */
export const sessionRef = (head: SessionHead): SessionRef => ({ id: head.header.id, owner: head.header.owner, incarnation: head.incarnation })
/** Whether a captured reference still identifies this head. @public */
export const sameSession = (reference: SessionRef, head: SessionHead): boolean => reference.id === head.header.id && reference.owner === head.header.owner && reference.incarnation === head.incarnation
