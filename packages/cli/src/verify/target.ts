import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { makeLocalRunner, type Runner } from "./runner.js"

/**
 * The target resolver. A `VerifyTarget` string resolves to either a NATIVE
 * target (a local `bun main.ts` runner over the working tree or a checked-out
 * commit — runs the full typed tiers) or a CONTAINER target (a clean-room npm
 * install of a published release — runs the container-native battery in run.ts).
 */

export interface NativeTarget {
  readonly kind: "native"
  readonly label: string
  readonly runner: Runner
  /** Source root for the UI-flow tests + the evals bridge; undefined ⇒ a
   *  published self-install (those tiers skip). */
  readonly repoRoot: string | undefined
}

export interface ContainerTarget {
  readonly kind: "container"
  readonly label: string
  /** The npm spec to install in the clean room, e.g. `efferent@0.2.0`. */
  readonly spec: string
  /** The version the boot check expects (the part after `@`), or undefined. */
  readonly expectVersion: string | undefined
}

export type ResolvedTarget = NativeTarget | ContainerTarget

/** Walk up from this file to the repo root (the dir that has `packages/cli/src/main.ts`). */
const sourceRoot = (): string | undefined => {
  const here = dirname(fileURLToPath(import.meta.url)) // …/packages/cli/src/verify
  const root = join(here, "..", "..", "..", "..")
  return existsSync(join(root, "packages/cli/src/main.ts")) ? root : undefined
}

const freshDir = (tag: string): string => mkdtempSync(join(tmpdir(), `efferent-verify-${tag}-`))

const sh = (cmd: ReadonlyArray<string>, cwd: string): Effect.Effect<boolean> =>
  Effect.tryPromise(async () => {
    const proc = Bun.spawn([...cmd], { cwd, stdout: "ignore", stderr: "ignore", env: process.env })
    return (await proc.exited) === 0
  }).pipe(Effect.orElseSucceed(() => false))

/** Build the source/self native target — the working tree, or (when bundled with
 *  no source) the running binary itself (UI-flow + evals tiers skip). */
const resolveSource = (): Effect.Effect<NativeTarget> =>
  Effect.sync(() => {
    const root = sourceRoot()
    const entry = root ? join(root, "packages/cli/src/main.ts") : (process.argv[1] ?? "efferent")
    const workspaceDir = freshDir("ws")
    const homeDir = freshDir("home")
    const runner = makeLocalRunner({
      entry,
      workspaceDir,
      homeDir,
      cleanup: Effect.sync(() => {
        rmSync(workspaceDir, { recursive: true, force: true })
        rmSync(homeDir, { recursive: true, force: true })
      }),
    })
    return {
      kind: "native",
      label: root ? "source" : "self (no source tree)",
      runner: { ...runner, supportsInProcess: root !== undefined },
      repoRoot: root,
    }
  })

/** Check out a commit into a throwaway worktree, `bun install`, run from there. */
const resolveCommit = (sha: string): Effect.Effect<NativeTarget> =>
  Effect.gen(function* () {
    const root = sourceRoot()
    if (root === undefined) {
      return yield* Effect.die(new Error("commit target needs a source checkout"))
    }
    const tree = freshDir(`commit-${sha.slice(0, 8)}`)
    const added = yield* sh(["git", "worktree", "add", "--detach", tree, sha], root)
    if (!added) return yield* Effect.die(new Error(`git worktree add failed for ${sha}`))
    yield* sh([process.execPath, "install"], tree) // bun install in the worktree
    const workspaceDir = freshDir("ws")
    const homeDir = freshDir("home")
    const runner = makeLocalRunner({
      entry: join(tree, "packages/cli/src/main.ts"),
      workspaceDir,
      homeDir,
      cleanup: Effect.gen(function* () {
        yield* sh(["git", "worktree", "remove", "--force", tree], root)
        yield* Effect.sync(() => {
          rmSync(workspaceDir, { recursive: true, force: true })
          rmSync(homeDir, { recursive: true, force: true })
        })
      }),
    })
    return { kind: "native", label: `commit:${sha}`, runner, repoRoot: tree }
  })

export const resolveTarget = (spec: string | undefined): Effect.Effect<ResolvedTarget> => {
  const t = (spec ?? "source").trim()
  if (t === "source" || t === "") return resolveSource()
  if (t.startsWith("commit:")) return resolveCommit(t.slice("commit:".length))
  if (t.startsWith("release:")) {
    const ver = t.slice("release:".length)
    return Effect.succeed({ kind: "container", label: t, spec: `efferent@${ver}`, expectVersion: ver })
  }
  if (t.startsWith("npm:")) {
    const ref = t.slice("npm:".length)
    const expectVersion = /^\d+\.\d+\.\d+/.test(ref) ? ref : undefined
    return Effect.succeed({ kind: "container", label: t, spec: `efferent@${ref}`, expectVersion })
  }
  return Effect.die(new Error(`unknown target "${t}" (want source | commit:<sha> | release:<ver> | npm:<spec>)`))
}
