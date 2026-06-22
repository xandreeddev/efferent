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
  type Memory,
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
  readonly memory: ReadonlyArray<Memory>
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
      memory: input.memory,
      agents: input.agents,
      tools: input.tools,
      allowBash: input.allowBash,
    })
    const cs = yield* ConversationStore

    yield* Effect.logInfo(`scheduler running for ${input.cwd} (Ctrl-C to stop)`)

    const fire = (job: { id: string; folder: string; prompt: string; agent?: string }, nowMs: number) =>
      Effect.gen(function* () {
        const cid = yield* cs.create(input.cwd).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        if (cid === undefined) return
        yield* Effect.logInfo(`fire: ${job.prompt}`).pipe(
          Effect.annotateLogs("scheduled_at", new Date(nowMs).toISOString()),
        )
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
            Effect.tap((r) => Effect.logInfo(`scheduled job done: ${r.summary.slice(0, 200)}`)),
            Effect.catchAll((e) =>
              Effect.logError(`scheduled job failed: ${e.error}: ${e.message ?? ""}`),
            ),
            Effect.catchAllDefect((d) => Effect.logError(`scheduled job crashed: ${String(d)}`)),
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
