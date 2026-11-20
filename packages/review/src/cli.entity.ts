import { Schema } from "effect"

/** The command line was not one the reviewer reads: what is wrong, and the usage. */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
}) {}

/** How to call the reviewer. */
export const USAGE = [
  "efferent-review prepare <number> --repo <owner/name> [--at head|first|<sha>] [--budget <tokens>] [--workflow <path>]... [--cache <folder>] [--records <folder>] [--run <command>]... [--validate] [--json]",
  "efferent-review review <number> --repo <owner/name> [--at head|first|<sha>] [--budget <tokens>] [--focus groups|whole] [--group-steps <n>] [--group-order risk|git] [--config-turn] [--turns <n>] [--finder candidates|strict] [--effort-find <e>] [--effort-check <e>] [--vote] [--no-verify] [--max-cost <usd>] [--find-cost <usd>] [--verify-cost <usd>] [--max-steps <n>] [--verify-steps <n>] [--model <id> --price <in,cached,out>] [--workflow <path>]... [--cache <folder>] [--records <folder>] [--run <command>]... [--validate] [--json]",
].join("\n")
