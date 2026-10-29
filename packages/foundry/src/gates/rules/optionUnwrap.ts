import { RuleId } from "../../domain/Brands.js"
import type { IdiomRule } from "../idiomGate.js"
import { isMemberOf, matchesIn } from "./syntax.js"

/** `Option.getOrNull`/`getOrUndefined` turn absence back into a nullable:
 *  right where a foreign API or the wire needs one (an adapter), wrong in
 *  the code between, which then checks for `null` again. */
export const noOptionUnwrap: IdiomRule = {
  id: RuleId.make("effect/no-option-unwrap"),
  defaultSeverity: "error",
  description: "an `Option` stays an `Option` until an adapter hands it to a foreign API or the wire",
  fixHint:
    "keep the `Option`: `Option.match`, `Option.map`, `Option.getOrElse` with a real default, or an optional field spread from `Option.match`; unwrap to `null`/`undefined` only in a `*.adapter.ts` that writes to the wire or calls a foreign API",
  check: ({ sourceFile }) =>
    matchesIn(sourceFile, (node) =>
      isMemberOf(node, "Option", ["getOrNull", "getOrUndefined"])
        ? [{ node, message: `\`Option.${node.name.text}\` turns absence back into a nullable` }]
        : [],
    ),
}
