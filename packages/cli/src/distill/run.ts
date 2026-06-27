import { homedir } from "node:os"
import { Effect } from "effect"
import {
  AuthStore,
  type AgentMessage,
  type Candidate,
  type ConversationId,
  ConversationStore,
  type DistillResult,
  distill,
  type FileSystem,
  runDistillation,
  SettingsStore,
  type UtilityLlm,
  type Verifier,
} from "@xandreed/sdk-core"
import { loadMemory } from "../usecases/loadMemory.js"
import { loadSkills } from "../usecases/loadSkills.js"

/** Roster row shape from `ConversationStore.listByWorkspace` (the mining set). */
interface ConvRow {
  readonly id: ConversationId
  readonly createdAt: number
  readonly firstPrompt?: string
  readonly title?: string
}

/**
 * `efferent distill` — the self-improving loop driver
 * (`docs/self-improving-loop.md`). Enumerate finished conversations from the DB
 * and, for each, mine candidate learnings on the cheap fast tier (the
 * **Reflector**). Without `--dry-run` each candidate is then refuted by the Opus
 * verify gate (the **Closer**, `claude` headless) and survivors are persisted as
 * delta items (the **Curator**) the next run auto-loads. `--dry-run` stops after
 * mining — no gate, no writes, no `claude` cost.
 */
export interface DistillOptions {
  readonly workspace: string
  readonly dryRun: boolean
  readonly since?: string
  readonly conversation?: string
  readonly limit?: number
  readonly threshold?: number
}

const out = (s: string): Effect.Effect<void> =>
  Effect.sync(() => process.stdout.write(s))

const formatCandidate = (c: Candidate): string =>
  `  • [${c.kind}] ${c.name} — ${c.description}\n`

const formatResult = (r: DistillResult): string => {
  const status = r.accepted
    ? r.persisted !== undefined
      ? `✓ saved ${r.persisted.path}`
      : "✓ accepted"
    : "✗ rejected"
  return (
    `  • [${r.candidate.kind}] ${r.candidate.name} — ${status} ` +
    `(score ${r.verdict.score.toFixed(2)}: ${r.verdict.reason})\n`
  )
}

export const runDistill = (
  opts: DistillOptions,
): Effect.Effect<
  void,
  never,
  ConversationStore | SettingsStore | AuthStore | FileSystem | UtilityLlm | Verifier
> =>
  Effect.gen(function* () {
    // Bind the workspace so the fast model + its key resolve (mirrors how the
    // interactive modes prepare a workspace). Best-effort — a settings/auth miss
    // surfaces later as an empty candidate list, not a crash.
    yield* (yield* SettingsStore)
      .load(opts.workspace, homedir())
      .pipe(Effect.catchAll(() => Effect.void))
    yield* (yield* AuthStore).init(opts.workspace).pipe(Effect.catchAll(() => Effect.void))

    // Existing library names — so the miner doesn't re-propose them and the gate
    // can reject redundant candidates.
    const skills = yield* loadSkills(opts.workspace, homedir())
    const memory = yield* loadMemory(opts.workspace, homedir())
    const existing = [...skills.map((s) => s.name), ...memory.map((m) => m.name)]

    const store = yield* ConversationStore
    const all = yield* store
      .listByWorkspace(opts.workspace)
      .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<ConvRow>)))

    const sinceMs = opts.since !== undefined ? Date.parse(opts.since) : Number.NaN
    let targets = [...all].sort((a, b) => b.createdAt - a.createdAt)
    if (opts.conversation !== undefined) {
      const q = opts.conversation
      targets = targets.filter((c) => c.id === q || c.id.startsWith(q))
    }
    if (!Number.isNaN(sinceMs)) targets = targets.filter((c) => c.createdAt >= sinceMs)
    if (opts.limit !== undefined && opts.limit > 0) targets = targets.slice(0, opts.limit)

    if (targets.length === 0) {
      yield* out("distill: no matching conversations.\n")
      return
    }

    yield* out(
      `distill: mining ${targets.length} conversation(s)${opts.dryRun ? " (dry-run — no gate, no writes)" : ""}\n\n`,
    )

    let candidateCount = 0
    let acceptedCount = 0
    let persistedCount = 0

    for (const conv of targets) {
      const messages = yield* store
        .list(conv.id)
        .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<AgentMessage>)))
      if (messages.length === 0) continue
      const label = conv.title ?? conv.firstPrompt ?? conv.id

      if (opts.dryRun) {
        const candidates = yield* distill({
          conversationId: conv.id,
          messages,
          existing,
        })
        candidateCount += candidates.length
        yield* out(`▸ ${label}  (${candidates.length} candidate(s))\n`)
        for (const c of candidates) yield* out(formatCandidate(c))
      } else {
        const results = yield* runDistillation({
          conversationId: conv.id,
          messages,
          repoDir: opts.workspace,
          globalDir: homedir(),
          existing,
          ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
        })
        candidateCount += results.length
        for (const r of results) {
          if (r.accepted) acceptedCount += 1
          if (r.persisted !== undefined) persistedCount += 1
        }
        yield* out(`▸ ${label}  (${results.length} candidate(s))\n`)
        for (const r of results) yield* out(formatResult(r))
      }
      if (messages.length > 0) yield* out("\n")
    }

    yield* out(
      opts.dryRun
        ? `distill: ${candidateCount} candidate(s) — re-run without --dry-run to verify + save.\n`
        : `distill: ${candidateCount} candidate(s), ${acceptedCount} accepted, ${persistedCount} persisted.\n`,
    )
  }).pipe(
    Effect.catchAll((e) =>
      out(`distill: error: ${(e as { message?: string }).message ?? String(e)}\n`).pipe(
        Effect.zipRight(Effect.sync(() => void (process.exitCode = 1))),
      ),
    ),
  )
