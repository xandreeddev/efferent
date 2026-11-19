import { Clock, Effect, Option } from "effect"
import type { Ran, Shell } from "@xandreed/sdk"
import { Checkout } from "./checkout.port.js"
import type { LogDigest } from "./log-digest.entity.js"
import { digestLog } from "./log-digest.entity.functions.js"
import type { CommitSha } from "./pull-request.entity.js"
import { INSTRUCTION_FILES, LOCKFILES, REGISTRY_CONFIG } from "./repo-profile.entity.js"
import type { Candidate, Manager } from "./repo-profile.entity.js"
import { managerOf, profileOf } from "./repo-profile.entity.functions.js"
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
 * Run a pull request's commands, each phase in a sandbox of its own over a throwaway clone (`Checkout.clone`, made
 * before any sandbox writes to it, and never touched by host git after): the manager chosen from the base's lockfile
 * (`managerOf`); the profile (`profileOf`: the base's definition of done and check scripts with `profile`, and the
 * commands given by hand), each command not yet known to pass with the base's lockfile asked on a clone of the base
 * and kept only when it exits 0 there, the pass kept in the cache; then the head's clone installed and every kept
 * command run on it. Each clone installs first, the network shared and the bot's package cache bound (one of its own,
 * thrown away, for a head that changes the registry's config), with no script of the repository's; or restores a
 * snapshot of the base's `node_modules` kept under the same files; then runs its commands with no network, one after
 * another, under `allowOnly`, each with the command's time or what is left of the clone's budget. Every log is kept
 * whole and digested.
 */
export const validate = Effect.fn("review.validate")(function* (request: ValidationRequest) {
  const checkout = yield* Checkout
  const sandboxes = yield* Sandboxes
  const logs = yield* ReviewLogs
  const cache = yield* ReviewCache
  const repo = request.repo
  const showAt = (at: CommitSha, path: string) => checkout.show(repo, at, path)
  const packageJson = yield* showAt(request.base, "package.json")
  const yarnrc = yield* showAt(request.base, ".yarnrc.yml")
  const lockfiles = (yield* Effect.forEach(LOCKFILES, ([file]) => Effect.map(showAt(request.base, file), (text) => Option.isSome(text) ? [file] : []), { concurrency: 1 })).flat()
  const choice = managerOf({ lockfiles, packageJson, yarnrc }, request.changedPaths, sandboxes.tools)
  if (choice._tag === "Refused") return { _tag: "Refused", reason: choice.reason } satisfies ValidationRun
  const instructions = request.profile ? (yield* Effect.forEach(INSTRUCTION_FILES, (path) => showAt(request.base, path), { concurrency: 1 })).flatMap(Option.toArray) : []
  const candidates = profileOf({ run: choice.run, packageJson, instructions, profile: request.profile, byHand: request.run })
  const lockfile = Option.getOrElse(yield* showAt(request.base, choice.lockfile), () => "")
  const passKey = (command: string) => ({ repo, lockfile, command })

  const keep = (name: string, command: string, ran: Ran) => Effect.gen(function* () {
    const text = logText(ran)
    const logPath = yield* logs.keep(`${request.logFolder}/${name}`, text)
    const { ended, exit } = endedOf(ran)
    const digest: LogDigest = { source: { _tag: "Command", command }, exit, ended, digest: digestLog(text, request.changedPaths, request.limits), logPath }
    return digest
  })

  /** A clone's install, or the snapshot restored in its place: its digest and whether it passed. */
  const install = (dir: string, at: CommitSha, side: "base" | "head", manager: Manager, timeoutMs: number) => Effect.gen(function* () {
    const files = (yield* Effect.forEach([choice.lockfile, "package.json", ...REGISTRY_CONFIG], (path) => Effect.map(showAt(at, path), (text) => Option.toArray(Option.map(text, (body) => ({ path, text: body })))), { concurrency: 1 })).flat()
    const key: SnapshotKey = { repo, manager, files }
    const saved = yield* cache.snapshot(key)
    if (Option.isSome(saved)) {
      const restorer = yield* sandboxes.shell({ workDir: dir, network: false, binds: [{ host: saved.value, inner: "/snapshot", writable: false }] })
      const ran = yield* restorer.run({ command: RESTORE_SNAPSHOT, timeoutMs })
      return { digest: yield* keep(`${side}-install.log`, RESTORE_SNAPSHOT, ran), passed: passed(ran) }
    }
    const ownCache = side === "head" && request.changedPaths.some((path) => (REGISTRY_CONFIG as ReadonlyArray<string>).includes(path))
    const packages = ownCache ? yield* cache.scratch(repo) : yield* cache.packages(repo, manager)
    const installer = yield* sandboxes.shell({ workDir: dir, network: true, binds: [{ host: packages, inner: "/cache", writable: true }] })
    const ran = yield* installer.run({ command: choice.install, timeoutMs })
    const digest = yield* keep(`${side}-install.log`, choice.install, ran)
    if (passed(ran) && side === "base") {
      yield* Effect.scoped(Effect.gen(function* () {
        const saving = yield* cache.saving(key)
        const saver = yield* sandboxes.shell({ workDir: dir, network: false, binds: [{ host: saving.dir, inner: "/snapshot", writable: true }] })
        const save = yield* saver.run({ command: SAVE_SNAPSHOT, timeoutMs })
        if (passed(save)) yield* saving.commit
      })).pipe(Effect.ignore({ log: "Warn", message: "the base's node_modules could not be kept as a snapshot" }))
    }
    return { digest, passed: passed(ran) }
  })

  /** Clone `at`, install, and run `commands` there with no network, within the clone's budget. */
  const inClone = (at: CommitSha, side: "base" | "head", commands: ReadonlyArray<string>) => Effect.scoped(Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + request.budgetMs
    const timeLeft = Effect.map(Clock.currentTimeMillis, (now) => Math.min(request.commandTimeoutMs, deadline - now))
    const dir = yield* checkout.clone(repo, at)
    const installed = yield* install(dir, at, side, choice.manager, Math.max(1, yield* timeLeft))
    if (!installed.passed) {
      const reason = side === "base" ? UNRUN_BECAUSE.baseInstall : UNRUN_BECAUSE.headInstall
      return { install: installed.digest, outcomes: commands.map((command): Outcome => ({ _tag: "Unrun", command, reason })) }
    }
    const shell: Shell["Service"] = allowOnly(commands, yield* sandboxes.shell({ workDir: dir, network: false, binds: [] }))
    const outcomes = yield* Effect.forEach(commands, (command, index) => Effect.gen(function* () {
      const left = yield* timeLeft
      if (left < LEAST_MS) return { _tag: "Unrun", command, reason: UNRUN_BECAUSE.budget } satisfies Outcome
      const ran = yield* shell.run({ command, timeoutMs: left })
      return { _tag: "Ran", command, digest: yield* keep(`${side}-${index + 1}.log`, command, ran), passed: passed(ran) } satisfies Outcome
    }), { concurrency: 1 })
    return { install: installed.digest, outcomes }
  }))

  const fromProfile = (candidate: Candidate) => candidate.kept && candidate.from !== "by-hand"
  const known = yield* Effect.forEach(candidates, (candidate) => fromProfile(candidate) ? cache.passed(passKey(candidate.command)) : Effect.succeed(false), { concurrency: 1 })
  const toAsk = candidates.filter((candidate, at) => fromProfile(candidate) && known[at] !== true).map((candidate) => candidate.command)
  const onBase = toAsk.length === 0 ? [] : (yield* inClone(request.base, "base", toAsk)).outcomes
  yield* Effect.forEach(onBase, (outcome) => outcome._tag === "Ran" && outcome.passed ? cache.pass(passKey(outcome.command)) : Effect.void, { concurrency: 1 })
  const profile = candidates.map((candidate, at): ProfileEntry => {
    if (!candidate.kept) return candidate
    if (candidate.from === "by-hand") return { ...candidate, reason: UNRUN_BECAUSE.byHand }
    if (known[at] === true) return { ...candidate, reason: UNRUN_BECAUSE.passedBefore }
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
    install: Option.some(onHead.install),
    digests: onHead.outcomes.flatMap((outcome) => outcome._tag === "Ran" ? [outcome.digest] : []),
    unrun: onHead.outcomes.flatMap((outcome): ReadonlyArray<Unrun> => outcome._tag === "Unrun" ? [{ command: outcome.command, reason: outcome.reason }] : []),
  } satisfies ValidationRun
})
