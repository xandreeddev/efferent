import type { Transport } from "./checkout.entity.js"

/**
 * A host-side git command's argv: no hook runs (`core.hooksPath=/dev/null`), no file-system monitor starts, no
 * transport but `transports` is allowed (`protocol.allow=never`, then each one `always`), and every path is literal
 * (`--literal-pathspecs`: a folder named `:(glob)x` or `:!x` is a name, never pathspec magic). `gitDir` is the
 * repository the command runs in (`-C`), none for a clone.
 */
export const gitArgv = (transports: ReadonlyArray<Transport>, gitDir: string | null, args: ReadonlyArray<string>): ReadonlyArray<string> => [
  "git",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "protocol.allow=never",
  ...transports.flatMap((transport) => ["-c", `protocol.${transport}.allow=always`]),
  "--literal-pathspecs",
  ...(gitDir === null ? [] : ["-C", gitDir]),
  ...args,
]
