import { Schema } from "effect"

/** The command line was not one the reviewer reads: what is wrong, and the usage. */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
}) {}

/** How to call the reviewer. */
export const USAGE = [
  "efferent-review prepare <number> --repo <owner/name> [--at head|first|<sha>] [--budget <tokens>] [--workflow <path>]... [--cache <folder>] [--json]",
  "efferent-review review <number> --repo <owner/name> [--at head|first|<sha>] [--budget <tokens>] [--max-cost <usd>] [--max-steps <n>] [--model <id> --price <in,cached,out>] [--workflow <path>]... [--cache <folder>] [--json]",
].join("\n")
