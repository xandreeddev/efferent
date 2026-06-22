#!/usr/bin/env bun
/**
 * The `code` bin entry — the focused single-fleet coder.
 *
 * Why a dedicated entry instead of sniffing the invoked name: under Bun, a
 * `#!/usr/bin/env bun` script launched through a symlink (how npm installs a
 * bin) re-execs `bun <resolved-target>`, so `process.argv[1]` is the *resolved*
 * bundle path (`efferent.js`) and `process.argv0` is `bun` — neither carries
 * the symlink name `code`. So name-based detection in `main.ts` can't fire for
 * an installed `code` bin. This shim makes the launch deterministic: it injects
 * `--code` into argv (idempotent) and then runs the shared CLI, which reads the
 * flag and selects the in-process driver + `variant: "code"`.
 *
 * TODO(release): the bin name `code` collides with the VS Code CLI (`code .`).
 * Confirm the published name before cutting a release — `ecode`/`effc`/keeping
 * it behind `efferent --code` are the alternatives.
 */
if (!process.argv.includes("--code")) process.argv.splice(2, 0, "--code")
// Dynamic import (not static) so the splice runs first — `main.ts` kicks off the
// CLI at module top level. `void` + `.then`-free keeps this a module without a
// top-level await (tsc TS1375). Errors surface through the CLI's own handling.
void import("./main.js")

export {}
