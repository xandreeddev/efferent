import { Clock, Effect } from "effect"
import {
  ContextTreeStore,
  ConversationStore,
  FileSystem,
  Http,
  SettingsStore,
  Shell,
  UtilityLlm,
  WebSearch,
  type AgentDefinition,
  type Scope,
  type Memory,
  type Skill,
  buildScopeRuntime,
} from "@xandreed/sdk-core"
import { LanguageModel } from "@effect/ai"
import type { ToolDefinition } from "@xandreed/sdk-core"
import {
  cronMatches,
  loadJobs,
  markJobRun,
  minuteBucket,
  parseCron,
} from "@xandreed/sdk-core"
import type { AgentEvent } from "../events.js"
import { makeHeadlessApproval } from "../workspace/headlessApproval.js"
import { makeJobController } from "../workspace/inProcess.js"
import { renderInstructionsSection, type InstructionFile } from "../usecases/discoverInstructionFiles.js"

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
  readonly instructionFiles: ReadonlyArray<InstructionFile>
  readonly rootScope: Scope
  readonly allowBash: boolean
}

export const runDaemonMode = (
  input: DaemonModeInput,
): Effect.Effect<
  void,
  never,
  | FileSystem
  | Http
  | Shell
  | LanguageModel.LanguageModel
  | ConversationStore
  | ContextTreeStore
  | WebSearch
  // The headless parking approval (replacing allow-all) runs the fast-tier judge,
  // so the unattended scheduler now needs the same two services every other mode
  // does (provided by the daemon command's `AppLive`).
  | SettingsStore
  | UtilityLlm
> =>
  Effect.gen(function* () {
    const runtime = buildScopeRuntime(input.rootScope, {
      skills: input.skills,
      memory: input.memory,
      agents: input.agents,
      tools: input.tools,
      instructions: renderInstructionsSection(input.instructionFiles),
      allowBash: input.allowBash,
    })
    const cs = yield* ConversationStore

    yield* Effect.logInfo(`scheduler running for ${input.cwd} (Ctrl-C to stop)`)

    // No clients are attached to the cron daemon, so a parked decision has
    // nowhere to render — log `needs_human` to the daemon log (the durable
    // record for a human to review later); other events are ignored here.
    const publish = (event: AgentEvent): Effect.Effect<void> =>
      event.type === "needs_human"
        ? Effect.logWarning(
            `needs_human (parked): ${event.tool ?? "?"} — ${event.reason} | ${event.summary}`,
          )
        : Effect.void

    // Route the tick through the JobController: a scheduled job is unattended, so
    // its approval is the headless parking approval (NEVER allow-all) and its
    // mission is seeded to the prompt so the run + its sub-agents know the goal.
    const jobs = makeJobController({
      runtime,
      scheduledApproval: makeHeadlessApproval(publish),
    })

    const fire = (job: { id: string; folder: string; prompt: string; agent?: string }, nowMs: number) =>
      Effect.gen(function* () {
        const cid = yield* cs.create(input.cwd).pipe(
          Effect.catchAll((e) => Effect.logError(`scheduled job: could not create conversation: ${e}`).pipe(Effect.zipRight(Effect.succeed(undefined)))),
        )
        if (cid === undefined) return
        yield* Effect.logInfo(`fire: ${job.prompt}`).pipe(
          Effect.annotateLogs("scheduled_at", new Date(nowMs).toISOString()),
        )
        yield* jobs
          .submitJob({
            conversationId: cid,
            source: "scheduled",
            interactionPolicy: "headless",
            folder: job.folder,
            prompt: job.prompt,
            title: `scheduled: ${job.prompt.slice(0, 30)}`,
            ...(job.agent !== undefined ? { agent: job.agent } : {}),
          })
          .pipe(
            Effect.tap(() => Effect.logInfo(`scheduled job submitted: ${job.prompt.slice(0, 120)}`)),
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
    }).pipe(Effect.catchAll((e) => Effect.logError(`scheduler tick failed: ${e}`)))

    yield* Effect.forever(tick.pipe(Effect.delay("60 seconds")))
  })
