import { homedir } from "node:os"
import { Effect, Option } from "effect"
import {
  ContextTreeStore,
  ConversationStore,
  FileSystem,
  runAutoDistill,
  SettingsStore,
  UtilityLlm,
  Verifier,
  type ConversationId,
  type DistillResult,
  type Memory,
  type Skill,
} from "@xandreed/sdk-core"
import { loadConstraintIds } from "../usecases/loadConstraintIds.js"

/**
 * Headless turn-boundary distillation: after a one-shot `-p`/`--json` run
 * delivers, mine the conversation for reusable lessons and persist them so the
 * NEXT run inherits them — the self-improving loop's "learn" step on the headless
 * path (it used to fire only in `efferent code`). Gated on `autoDistill` (the
 * same knob as the TUI/daemon; `:set autoDistill off` / config to skip it on
 * automation), awaited (the process is about to exit) but time-bounded and fully
 * fail-soft so it can never hang or break the run. Returns the persisted lessons
 * for the caller to surface (stderr line / `learned` event).
 */
export const headlessDistill = (args: {
  readonly conversationId: ConversationId
  readonly repoDir: string
  readonly skills: ReadonlyArray<Skill>
  readonly memory: ReadonlyArray<Memory>
}): Effect.Effect<
  ReadonlyArray<DistillResult>,
  never,
  SettingsStore | ConversationStore | ContextTreeStore | UtilityLlm | Verifier | FileSystem
> =>
  Effect.gen(function* () {
    const settings = yield* (yield* SettingsStore).get()
    if (settings.autoDistill === false) return [] as ReadonlyArray<DistillResult>
    const constraintIds = yield* loadConstraintIds(args.repoDir)
    const existing = [
      ...args.skills.map((s) => s.name),
      ...args.memory.map((m) => m.name),
      ...constraintIds,
    ]
    const out = yield* runAutoDistill({
      conversationId: args.conversationId,
      repoDir: args.repoDir,
      globalDir: homedir(),
      existing,
    }).pipe(Effect.timeoutOption("180 seconds"))
    return Option.getOrElse(out, () => [] as ReadonlyArray<DistillResult>)
  }).pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<DistillResult>)))
