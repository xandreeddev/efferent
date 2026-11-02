import { Option, Predicate } from "effect"
import { TAGGED_CODES, TAGGED_REASON_CODES } from "./harness-code.entity.js"
import type { HarnessCode } from "./harness-code.entity.js"
import { HarnessError } from "./plugin.entity.js"
import { isHarnessError } from "./plugin.entity.functions.js"

const taggedCodes: ReadonlyMap<string, string> = new Map(Object.entries(TAGGED_CODES))
const reasonCodes: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(Object.entries(TAGGED_REASON_CODES).map(([tag, codes]) => [tag, new Map(Object.entries(codes))]))

const stringField = (value: unknown, key: string): Option.Option<string> =>
  Predicate.isObject(value) ? Option.filter(Option.some(value[key]), Predicate.isString) : Option.none()

/**
 * The framework's code for a failure, told by its tag and fields, whichever
 * copy of `@xandreed/core` made it: a `HarnessError`'s own `code`; else the
 * code its tag stands for (`TAGGED_CODES`: `SessionBusy` is `session.busy`,
 * `TurnClosed` is `turn.closed`); else the code its tag and `reason` stand
 * for (`TAGGED_REASON_CODES`: a `TaskControlRefused` of reason
 * `unknown-question` is `task.question-unknown`); else a tagged error's own string `code`
 * (the models plugin's `AuthError` gives `auth.corrupt`). None for anything
 * else: an untagged value, a Node error's `ENOENT` among them (`errorCodeOf`
 * reads that).
 */
export const harnessCodeOf = (error: unknown): Option.Option<string> =>
  isHarnessError(error) ? Option.some(error.code) : Option.flatMap(stringField(error, "_tag"), (tag) =>
    Option.orElse(Option.fromNullishOr(taggedCodes.get(tag)), () => Option.orElse(
      Option.flatMap(stringField(error, "reason"), (reason) => Option.fromNullishOr(reasonCodes.get(tag)?.get(reason))),
      () => stringField(error, "code"),
    )))

/** A `HarnessError` of one of the framework's published codes, with what failed underneath as its `cause`. */
export const harnessError = (code: HarnessCode, message: string, cause?: unknown): HarnessError =>
  new HarnessError({ code, message, ...(cause === undefined ? {} : { cause }) })
