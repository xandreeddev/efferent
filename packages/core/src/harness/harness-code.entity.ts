import { Schema } from "effect"
import { turnBeginCodes } from "../session/sessions.entity.js"

/**
 * Every code the framework's packages raise, or store in a `turn.ended`
 * failure, a task's result or its status: a `HarnessError`'s, a
 * `SessionLogError`'s, the codes the tags of `TAGGED_CODES` stand for, and
 * the tagged errors' own (the models plugin's `AuthError` and
 * `SettingsError`). The list is
 * published: a code is never renamed or removed, only added, with its
 * meaning in the event reference (`scripts/generate-event-reference.ts`,
 * which fails on a code a package raises that is not here). A host's and a
 * third-party plugin's own codes are not in it; `HarnessError.code` stays
 * any string.
 */
export const HARNESS_CODES = [
  "auth.corrupt",
  "capability.catalog",
  "capability.forbidden",
  "config.budget",
  "config.graph",
  "config.options",
  "config.profile",
  "context.budget",
  "events.background",
  "events.depth",
  "events.encode",
  "events.reserved",
  "loop.failed",
  "loop.model",
  "matcher.timeout",
  "memory.digest",
  "memory.log",
  "memory.summary",
  "module.closed",
  "plugin.activation",
  "plugin.defect",
  "request.decode",
  "request.descriptor",
  "request.diverged",
  "request.encode",
  "request.memory",
  "request.missing",
  "request.model",
  "requires.missing",
  "service.missing",
  "session.begin",
  "session.busy",
  "session.contended",
  "session.create",
  "session.decode",
  "session.defect",
  "session.encode",
  "session.expired",
  "session.log",
  "session.missing",
  "session.nothing-pending",
  "session.state",
  "session.version",
  "settings.corrupt",
  "skills.duplicate",
  "skills.files",
  "skills.limit",
  "skills.root",
  "skills.tools",
  "skills.unknown",
  "store.busy",
  "store.decode",
  "store.encode",
  "store.io",
  "store.open",
  "store.stalled",
  "store.version",
  "task.deadline",
  "task.lost",
  "task.refused",
  "task.removed",
  "task.turn",
  "tasks.encode",
  "tasks.kind",
  "tasks.lost",
  "tools.duplicate",
  "tools.opened",
  "tools.unavailable",
  "turn.attachment-rejected",
  "turn.budget",
  "turn.closed",
  "turn.defect",
  "turn.duplicate",
  "turn.failed",
  "turn.interrupted",
  "turn.key-conflict",
  "turn.lease",
  "turn.not-resumable",
  "turn.numbering",
  "turn.persisted",
  "turn.refused",
  "turn.run-reused",
  "turn.shutdown",
  "turn.takeover",
  "turn.time-limit",
  "turn.unended",
  "turn.unstarted",
] as const

/**
 * One of the framework's published codes (`HARNESS_CODES`).
 *
 * @public
 */
export const HarnessCode = Schema.Literals(HARNESS_CODES)
export type HarnessCode = typeof HarnessCode.Type

/**
 * The code each of the framework's tagged errors stands for, keyed by its
 * tag: the begin refusals (`turnBeginCodes`), `TurnClosed` and
 * `ReservedKind`. `harnessCodeOf` reads it, so a refusal stores the code a
 * `HarnessError` in its place would have.
 *
 * @public
 */
export const TAGGED_CODES = {
  ...turnBeginCodes,
  TurnClosed: "turn.closed",
  ReservedKind: "events.reserved",
} as const satisfies Readonly<Record<string, HarnessCode>>
