import { Clock, Effect } from "effect"
import {
  ApprovalAllowAllLive,
  ContextTreeStore,
  ConversationStore,
  FileSystem,
  Http,
  Shell,
  WebSearch,
  type AgentDefinition,
  type Scope,
  type Skill,
} from "@xandreed/sdk-core"
import { LanguageModel } from "@effect/ai"
import { buildScopeRuntime } from "../usecases/buildScopeRuntime.js"
import type { ToolDefinition } from "../usecases/loadTools.js"
import {
  cronMatches,
  loadJobs,
  markJobRun,
  minuteBucket,
  parseCron,
} from "../usecases/schedule.js"

/**
 * Phase 7 (Stage B, v1) — the headless **daemon**: a long-lived process that
 * runs the cron scheduler so this workspace's jobs fire even with no TUI open
 * (agents outliving the client — the concrete payoff of the daemon graduation).
 * Each due job runs to completion as a fresh, persisted conversation (visible
 * later in `:tree`/`:sessions`), forked so a long job never stalls the tick.
 *
 * The fuller Stage B — TUI/CLI attaching to a shared daemon over the rpc/json
 * protocol extended with `fleet.spawn`/`send`/`list`/`subscribe` (the openclaw
 * `sessions_*` shape), with the live fleet + bus hosted in the daemon — is the
 * deferred remainder. The agent loop here is identical to every other mode; the
 * daemon only changes WHERE it runs and FOR HOW LONG.
 */
export interface DaemonModeInput {
  readonly cwd: string
  readonly skills: ReadonlyArray<Skill>
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly rootScope: Scope
  readonly allowBash: boolean
}

export const runDaemonMode = (
  input: DaemonModeInput,
): Effect.Effect<
  void,
  never,
  FileSystem | Http | Shell | LanguageModel.LanguageModel | ConversationStore | ContextTreeStore | WebSearch
> =>
  Effect.gen(function* () {
    const runtime = buildScopeRuntime(input.rootScope, {
      skills: input.skills,
      agents: input.agents,
      tools: input.tools,
      allowBash: input.allowBash,
    })
    const cs = yield* ConversationStore

    process.stderr.write(
      `efferent daemon: scheduler running for ${input.cwd} (Ctrl-C to stop)\n`,
    )

    const fire = (job: { id: string; folder: string; prompt: string; agent?: string }, nowMs: number) =>
      Effect.gen(function* () {
        const cid = yield* cs.create(input.cwd).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        if (cid === undefined) return
        process.stderr.write(`[${new Date(nowMs).toISOString()}] fire: ${job.prompt}\n`)
        yield* runtime
          .spawnAgent({
            rootConversationId: cid,
            folder: job.folder,
            task: job.prompt,
            title: `scheduled: ${job.prompt.slice(0, 30)}`,
            ...(job.agent !== undefined ? { agent: job.agent } : {}),
          })
          .pipe(
            Effect.provide(ApprovalAllowAllLive),
            Effect.tap((r) =>
              Effect.sync(() => process.stderr.write(`  done: ${r.summary.slice(0, 200)}\n`)),
            ),
            Effect.catchAll((e) =>
              Effect.sync(() => process.stderr.write(`  failed: ${e.error}: ${e.message ?? ""}\n`)),
            ),
            Effect.catchAllDefect((d) =>
              Effect.sync(() => process.stderr.write(`  crashed: ${String(d)}\n`)),
            ),
          )
      })

    const tick = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis
      const now = new Date(nowMs)
      const jobs = yield* loadJobs()
      for (const job of jobs) {
        if (job.cwd !== input.cwd) continue
        const fields = parseCron(job.cron)
        if (fields === undefined || !cronMatches(fields, now)) continue
        if (job.lastRunMs !== undefined && minuteBucket(job.lastRunMs) === minuteBucket(nowMs)) {
          continue
        }
        yield* markJobRun(job.id, nowMs)
        // Fork so a long job doesn't stall the once-a-minute tick.
        yield* Effect.forkDaemon(fire(job, nowMs))
      }
    }).pipe(Effect.catchAll(() => Effect.void))

    yield* Effect.forever(tick.pipe(Effect.delay("60 seconds")))
  })
