import { Clock, Effect, Option } from "effect"
import type { Ran, Shell } from "@xandreed/sdk"
import { Checkout } from "./checkout.port.js"
import type { LogDigest } from "./log-digest.entity.js"
import { digestLog } from "./log-digest.entity.functions.js"
import type { CommitSha } from "./pull-request.entity.js"
import { INSTRUCTION_FILES, LOCKFILES } from "./repo-profile.entity.js"
import type { Candidate } from "./repo-profile.entity.js"
import { dependencyPaths, isDependencyPath, managerOf, profileOf, sameFiles } from "./repo-profile.entity.functions.js"
import { Forge } from "./forge.port.js"
import type { SnapshotKey } from "./review-cache.entity.js"
import { ReviewCache } from "./review-cache.port.js"
import { ReviewLogs } from "./review-logs.port.js"
import { Sandboxes } from "./sandboxes.port.js"
import { UNRUN_BECAUSE } from "./validations.entity.js"
import type { ProfileEntry, Unrun, ValidationRequest, ValidationRun } from "./validations.entity.js"
import { allowOnly, endedOf, logText, passed, RESTORE_SNAPSHOT, SAVE_SNAPSHOT } from "./validations.entity.functions.js"

/** The least time worth starting a command with, in milliseconds: with less left of a clone's budget it is not run. */
const LEAST_MS = 1_000

/** How a command of a clone's run came out: it ran, with its digest and whether it passed, or it did not, with why. */
type Outcome =
  | { readonly _tag: "Ran"; readonly command: string; readonly digest: LogDigest; readonly passed: boolean }
  | { readonly _tag: "Unrun"; readonly command: string; readonly reason: string }

/**
 * Run a pull request's commands, only when its base is in the history of the repository's default branch (checked
 * first, here) and no dependency file is a link or a submodule at either end,
 * each phase in a sandbox of its own over a throwaway clone (`Checkout.clone`, made before any sandbox writes to it,
 * and never touched by host git after). The manager is chosen from the base's lockfile (`managerOf`). The head is
 * validated only when its dependency files (every lockfile and every `package.json` of the tree) are byte for byte the
 * base's; otherwise nothing runs (`depsChanged`): a pull request's head never installs. Only the base installs, with
 * the network shared, the bot's package cache bound and no script of the repository's, every program by its absolute
 * path; its `node_modules` is kept as a snapshot under the base's commit, the files and the manager's version, and the
 * head restores it with no network. The profile (`profileOf`) is asked on the base, each command with no verdict for
 * this base yet kept only when it exits 0 there, the verdict kept for this base alone; then every kept command runs on
 * the head with no network, one after another, under `allowOnly`, each with the command's time or what is left of the
 * clone's budget. Every log is kept whole and digested.
 */
export const validate = Effect.fn("review.validate")(function* (request: ValidationRequest) {
  const checkout = yield* Checkout
  const sandboxes = yield* Sandboxes
  const logs = yield* ReviewLogs
  const cache = yield* ReviewCache
  const forge = yield* Forge
  const repo = request.repo
  // Only a base in the history of the default branch, as the forge names it and the remote has it now, is installed:
  // checked here, so no caller of the validations can install from another.
  if (!(yield* checkout.onBranch(repo, request.base, yield* forge.defaultBranch(repo)))) return { _tag: "Refused", reason: UNRUN_BECAUSE.untrustedBase } satisfies ValidationRun
  const showAt = (at: CommitSha, path: string) => checkout.show(repo, at, path)
  const packageJson = yield* showAt(request.base, "package.json")
  const yarnrc = yield* showAt(request.base, ".yarnrc.yml")
  const lockfiles = (yield* Effect.forEach(LOCKFILES, ([file]) => Effect.map(showAt(request.base, file), (text) => Option.isSome(text) ? [file] : []), { concurrency: 1 })).flat()
  const choice = managerOf({ lockfiles, packageJson, yarnrc }, request.changedPaths, sandboxes.tools)
  if (choice._tag === "Refused") return { _tag: "Refused", reason: choice.reason } satisfies ValidationRun

  const dependencies = (at: CommitSha) => Effect.gen(function* () {
    const paths = dependencyPaths(yield* checkout.files(repo, at))
    return (yield* Effect.forEach(paths, (path) => Effect.map(showAt(at, path), (text) => Option.toArray(Option.map(text, (body) => ({ path, text: body })))), { concurrency: 4 })).flat()
  })
  // A dependency file that is a link or a submodule at either end is read through it by an install: refused.
  const irregular = (at: CommitSha) => Effect.map(checkout.notRegular(repo, at), (paths) => paths.some(isDependencyPath))
  if ((yield* irregular(request.base)) || (yield* irregular(request.head))) return { _tag: "Refused", reason: UNRUN_BECAUSE.notRegular } satisfies ValidationRun
  const baseFiles = yield* dependencies(request.base)
  if (!sameFiles(baseFiles, yield* dependencies(request.head))) return { _tag: "Refused", reason: UNRUN_BECAUSE.depsChanged } satisfies ValidationRun

  const instructions = request.profile ? (yield* Effect.forEach(INSTRUCTION_FILES, (path) => showAt(request.base, path), { concurrency: 1 })).flatMap(Option.toArray) : []
  const candidates = profileOf({ run: choice.run, packageJson, instructions, profile: request.profile, byHand: request.run })
  const verdictKey = (command: string) => ({ repo, base: request.base, command })

  const keep = (name: string, command: string, ran: Ran) => Effect.gen(function* () {
    const text = logText(ran)
    const logPath = yield* logs.keep(`${request.logFolder}/${name}`, text)
    const { ended, exit } = endedOf(ran)
    const digest: LogDigest = { source: { _tag: "Command", command }, exit, ended, digest: digestLog(text, request.changedPaths, request.limits), logPath }
    return digest
  })

  /** The manager's version, asked in an empty sandbox with no network, for the snapshot's key. */
  const version = yield* Effect.scoped(Effect.gen(function* () {
    const shell = yield* sandboxes.shell({ workDir: yield* cache.scratch(repo), network: false, repoBins: false, binds: [] })
    const ran = yield* shell.run({ command: choice.version, timeoutMs: 30_000 })
    return passed(ran) ? ran.stdout.trim() : "unknown"
  }))
  const key: SnapshotKey = { repo, base: request.base, manager: choice.manager, version, files: baseFiles }

  /** Put the base's `node_modules` in a clone: restore the snapshot, with no network; none, nothing restored. */
  const restore = (dir: string, side: "base" | "head", timeoutMs: number) => Effect.gen(function* () {
    const saved = yield* cache.snapshot(key)
    if (Option.isNone(saved)) return Option.none<{ readonly digest: LogDigest; readonly passed: boolean }>()
    const restorer = yield* sandboxes.shell({ workDir: dir, network: false, repoBins: false, binds: [{ host: saved.value, inner: "/snapshot", writable: false }] })
    const ran = yield* restorer.run({ command: RESTORE_SNAPSHOT, timeoutMs })
    return Option.some({ digest: yield* keep(`${side}-restore.log`, RESTORE_SNAPSHOT, ran), passed: passed(ran) })
  })

  /** The base's install, the only one with the network, and its snapshot saved. */
  const installBase = (dir: string, timeoutMs: number) => Effect.gen(function* () {
    const packages = yield* cache.packages(repo, choice.manager)
    const installer = yield* sandboxes.shell({ workDir: dir, network: true, repoBins: false, binds: [{ host: packages, inner: "/cache", writable: true }] })
    const ran = yield* installer.run({ command: choice.install, timeoutMs })
    const digest = yield* keep("base-install.log", choice.install, ran)
    if (passed(ran)) {
      yield* Effect.scoped(Effect.gen(function* () {
        const saving = yield* cache.saving(key)
        const saver = yield* sandboxes.shell({ workDir: dir, network: false, repoBins: false, binds: [{ host: saving.dir, inner: "/snapshot", writable: true }] })
        const save = yield* saver.run({ command: SAVE_SNAPSHOT, timeoutMs })
        if (passed(save)) yield* saving.commit
      })).pipe(Effect.ignore({ log: "Warn", message: "the base's node_modules could not be kept as a snapshot" }))
    }
    return { digest, passed: passed(ran) }
  })

  /** Clone `at`, put the base's `node_modules` in it, and run `commands` there with no network, within the clone's budget. */
  const inClone = (at: CommitSha, side: "base" | "head", commands: ReadonlyArray<string>) => Effect.scoped(Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + request.budgetMs
    const timeLeft = Effect.map(Clock.currentTimeMillis, (now) => Math.min(request.commandTimeoutMs, deadline - now))
    const dir = yield* checkout.clone(repo, at)
    const restored = yield* restore(dir, side, Math.max(1, yield* timeLeft))
    const ready = Option.isSome(restored) ? Option.some(restored.value) : side === "base" ? Option.some(yield* installBase(dir, Math.max(1, yield* timeLeft))) : Option.none()
    const installed = Option.getOrElse(Option.map(ready, (each) => each.passed), () => false)
    if (!installed) {
      const reason = side === "base" ? UNRUN_BECAUSE.baseInstall : UNRUN_BECAUSE.noSnapshot
      return { install: Option.map(ready, (each) => each.digest), outcomes: commands.map((command): Outcome => ({ _tag: "Unrun", command, reason })) }
    }
    const shell: Shell["Service"] = allowOnly(commands, yield* sandboxes.shell({ workDir: dir, network: false, repoBins: true, binds: [] }))
    const outcomes = yield* Effect.forEach(commands, (command, index) => Effect.gen(function* () {
      const left = yield* timeLeft
      if (left < LEAST_MS) return { _tag: "Unrun", command, reason: UNRUN_BECAUSE.budget } satisfies Outcome
      const ran = yield* shell.run({ command, timeoutMs: left })
      return { _tag: "Ran", command, digest: yield* keep(`${side}-${index + 1}.log`, command, ran), passed: passed(ran) } satisfies Outcome
    }), { concurrency: 1 })
    return { install: Option.map(ready, (each) => each.digest), outcomes }
  }))

  const fromProfile = (candidate: Candidate) => candidate.kept && candidate.from !== "by-hand"
  const known = yield* Effect.forEach(candidates, (candidate) => fromProfile(candidate) ? cache.verdict(verdictKey(candidate.command)) : Effect.succeed(Option.none()), { concurrency: 1 })
  const toAsk = candidates.filter((candidate, at) => fromProfile(candidate) && Option.isNone(known[at] ?? Option.none())).map((candidate) => candidate.command)
  const needBase = toAsk.length > 0 || Option.isNone(yield* cache.snapshot(key))
  const onBase = needBase ? (yield* inClone(request.base, "base", toAsk)).outcomes : []
  yield* Effect.forEach(onBase, (outcome) => outcome._tag === "Unrun"
    ? Effect.void
    : cache.remember(verdictKey(outcome.command), outcome.passed ? { kept: true, reason: UNRUN_BECAUSE.passed } : { kept: false, reason: `on the base it ${outcome.digest.ended}` }), { concurrency: 1 })
  const profile = candidates.map((candidate, at): ProfileEntry => {
    if (!candidate.kept) return candidate
    if (candidate.from === "by-hand") return { ...candidate, reason: UNRUN_BECAUSE.byHand }
    const before = known[at] ?? Option.none()
    if (Option.isSome(before)) return before.value.kept ? { ...candidate, reason: UNRUN_BECAUSE.passedBefore } : { ...candidate, kept: false, reason: `${before.value.reason} ${UNRUN_BECAUSE.knownBefore}` }
    const outcome = onBase.find((each) => each.command === candidate.command)
    if (outcome === undefined || outcome._tag === "Unrun") return { ...candidate, kept: false, reason: outcome?.reason ?? UNRUN_BECAUSE.budget }
    return outcome.passed ? { ...candidate, reason: UNRUN_BECAUSE.passed } : { ...candidate, kept: false, reason: `on the base it ${outcome.digest.ended}` }
  })

  const commands = profile.filter((entry) => entry.kept).map((entry) => entry.command)
  if (commands.length === 0) return { _tag: "Ran", manager: choice.manager, profile, install: Option.none(), digests: [], unrun: [] } satisfies ValidationRun
  const onHead = yield* inClone(request.head, "head", commands)
  return {
    _tag: "Ran",
    manager: choice.manager,
    profile,
    install: onHead.install,
    digests: onHead.outcomes.flatMap((outcome) => outcome._tag === "Ran" ? [outcome.digest] : []),
    unrun: onHead.outcomes.flatMap((outcome): ReadonlyArray<Unrun> => outcome._tag === "Unrun" ? [{ command: outcome.command, reason: outcome.reason }] : []),
  } satisfies ValidationRun
})
