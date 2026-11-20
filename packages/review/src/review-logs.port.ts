import { Context } from "effect"
import type { Effect } from "effect"
import type { LogsUnavailable } from "./review-logs.entity.js"

/**
 * Where a review keeps the whole logs it digests and its records: `keep(name, text)` writes the text under a relative
 * name (folders made as needed), whole or not at all, and answers the path a person or a later step reads it from;
 * `folder(name)` makes a folder under a relative name and answers its path; `fresh(name)` makes one only when nothing
 * is there, and fails otherwise, so two runs never share a folder.
 */
export class ReviewLogs extends Context.Service<ReviewLogs, {
  readonly folder: (name: string) => Effect.Effect<string, LogsUnavailable>
  readonly fresh: (name: string) => Effect.Effect<string, LogsUnavailable>
  readonly keep: (name: string, text: string) => Effect.Effect<string, LogsUnavailable>
}>()("@xandreed/review/ReviewLogs") {}
