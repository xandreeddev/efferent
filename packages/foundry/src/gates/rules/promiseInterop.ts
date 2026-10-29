import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule } from "../idiomGate.js"
import { isMemberOf, matchesIn } from "./syntax.js"

/** `Effect.promise` declares that the promise cannot reject: when it does,
 *  the rejection is a defect no caller can handle. */
export const noEffectPromise: IdiomRule = {
  id: RuleId.make("effect/no-effect-promise"),
  defaultSeverity: "error",
  description: "foreign promises enter through `Effect.tryPromise`, never `Effect.promise`",
  fixHint:
    "use `Effect.tryPromise({ try, catch })` with a typed error, and log or handle the failure where it is expected",
  check: ({ sourceFile }) =>
    matchesIn(sourceFile, (node) =>
      isMemberOf(node, "Effect", ["promise"])
        ? [{ node, message: "`Effect.promise` turns a rejection into a defect" }]
        : [],
    ),
}

/** `Promise.all` starts every promise at once, with no bound and no
 *  interruption: the fiber running it cannot stop the work it started. */
export const noPromiseAll: IdiomRule = {
  id: RuleId.make("effect/no-promise-all"),
  defaultSeverity: "error",
  description: "concurrent work is an Effect with a stated `concurrency`, never `Promise.all`",
  fixHint:
    "use `Effect.forEach(items, f, { concurrency })` or `Effect.all(effects, { concurrency })`, each foreign promise wrapped in `Effect.tryPromise`",
  check: ({ sourceFile }) =>
    matchesIn(sourceFile, (node) =>
      isMemberOf(node, "Promise", ["all", "allSettled"])
        ? [{ node, message: `\`Promise.${node.name.text}\` runs unbounded and cannot be interrupted` }]
        : [],
    ),
}
