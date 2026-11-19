import { Schema } from "effect"

/** The command line was not one the reviewer reads: what is wrong, and the usage. */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  message: Schema.String,
}) {}

/** How to call the reviewer. */
export const USAGE = [
  "efferent-review prepare <number> --repo <owner/name> [--run <command>]... [--budget <tokens>] [--workflow <path>]...",
  "                [--cache <folder>] [--timeout-ms <ms>] [--json]",
].join("\n")
