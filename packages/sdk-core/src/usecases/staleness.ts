import { Effect } from "effect"
import { Shell } from "../ports/Shell.js"

/**
 * Context **staleness**: a persisted sub-agent context is a cache of a
 * world-model whose backing store — the repo — keeps changing. A node that
 * read files two commits ago and is resumed today will confidently act on
 * its in-context copies; models trust context over re-reading. So nodes are
 * stamped with the workspace git ref (HEAD) when their run finishes, and a
 * resume/branch against a moved HEAD injects a **staleness brief**: which ref
 * range moved and a `diff --stat` of what changed inside the node's folder,
 * with an explicit instruction to re-read before editing.
 *
 * Everything here is best-effort by design — a non-git workspace, a missing
 * `git` binary, or a GC'd old ref must never break a spawn. Failures mean
 * "no stamp" / "no brief", not errors.
 */

const GIT_TIMEOUT_MS = 5_000
const MAX_DIFF_LINES = 25

const execOut = (
  command: string,
  cwd: string,
): Effect.Effect<string | undefined, never, Shell> =>
  Effect.gen(function* () {
    const shell = yield* Shell
    const res = yield* shell
      .exec({ command, cwd, timeoutMs: GIT_TIMEOUT_MS })
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
    if (res === undefined || res.exitCode !== 0) return undefined
    const out = res.stdout.trim()
    return out.length > 0 ? out : undefined
  })

/** The workspace's current git HEAD, or `undefined` outside a repo. */
export const getWorkspaceRef = (
  dir: string,
): Effect.Effect<string | undefined, never, Shell> =>
  execOut("git rev-parse HEAD", dir)

/**
 * `git diff --stat` between a node's stamped ref and the current HEAD,
 * limited to `folder` (the node's scope — changes elsewhere don't invalidate
 * its context). Clipped to {@link MAX_DIFF_LINES}; `undefined` when nothing
 * in the folder changed or git can't answer (e.g. the old ref was GC'd).
 */
export const diffStatSince = (
  dir: string,
  oldRef: string,
  folder: string,
): Effect.Effect<string | undefined, never, Shell> =>
  Effect.gen(function* () {
    const out = yield* execOut(
      `git diff --stat ${oldRef}..HEAD -- ${JSON.stringify(folder)}`,
      dir,
    )
    if (out === undefined) return undefined
    const lines = out.split("\n")
    return lines.length <= MAX_DIFF_LINES
      ? out
      : [...lines.slice(0, MAX_DIFF_LINES), `… (${lines.length - MAX_DIFF_LINES} more lines)`].join("\n")
  })

const short = (ref: string): string => ref.slice(0, 7)

/**
 * The brief prepended to a resumed/branched task when the workspace moved.
 * Plain prose the model reads as part of its task message; the imperative
 * last line is the part that actually changes behavior.
 */
export const stalenessNote = (args: {
  readonly oldRef: string
  readonly newRef: string
  readonly folder: string
  readonly diffStat?: string
}): string => {
  const head = `[workspace changed since this context last ran: ${short(args.oldRef)}..${short(args.newRef)}]`
  const body =
    args.diffStat !== undefined
      ? `Changed under ${args.folder} since then:\n${args.diffStat}`
      : `(no changes under ${args.folder} itself, but the repo moved — shared code may differ)`
  return `${head}\n${body}\nFiles you read earlier may be stale — re-read anything you intend to edit before editing it.`
}

/**
 * Build the staleness brief for resuming/branching `node`-like data, or
 * `undefined` when there's nothing to warn about (same ref, no stamp, or not
 * a git workspace).
 */
export const buildStalenessBrief = (args: {
  readonly workspaceDir: string
  readonly nodeFolder: string
  readonly stampedRef: string | undefined
}): Effect.Effect<string | undefined, never, Shell> =>
  Effect.gen(function* () {
    if (args.stampedRef === undefined) return undefined
    const current = yield* getWorkspaceRef(args.workspaceDir)
    if (current === undefined || current === args.stampedRef) return undefined
    const diffStat = yield* diffStatSince(args.workspaceDir, args.stampedRef, args.nodeFolder)
    return stalenessNote({
      oldRef: args.stampedRef,
      newRef: current,
      folder: args.nodeFolder,
      ...(diffStat !== undefined ? { diffStat } : {}),
    })
  })
