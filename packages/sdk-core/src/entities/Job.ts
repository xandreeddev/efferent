import type { ConversationId } from "./Conversation.js"

/**
 * A unit of work the control-plane runs — the **unification** of the three ways
 * a turn starts: a human typing in the TUI (`"interactive"`), a message queued
 * while a turn ran (`"queued"`), and a cron tick firing (`"scheduled"`). The
 * `JobController` (the daemon workspace) routes a `Job` to the right primitive
 * (`send`/queue for interactive, `spawnAgent` for scheduled) and — crucially —
 * sets the run's `interactionPolicy` + seeds its `mission` CONSISTENTLY, so a
 * scheduled run is unattended-aware (headless approval) and its sub-agents know
 * the overall goal, which the bare `spawnAgent` call never set.
 *
 * Pure data — no IO, no Schema needed yet (it doesn't cross the wire today; it's
 * an in-process routing descriptor). `ConversationId` is the run's conversation;
 * a scheduled job's caller creates a fresh one per fire.
 */
export interface Job {
  /** The conversation this job runs in (a scheduled fire makes a fresh one). */
  readonly conversationId: ConversationId
  /** Folder scope for the run (relative to the workspace root, or absolute). */
  readonly folder: string
  /** The task/prompt to run — also the run's `mission`. */
  readonly prompt: string
  /** Where the job came from: a human turn, a queued turn, or a cron tick. */
  readonly source: "interactive" | "queued" | "scheduled"
  /** Whether a human is watching — picks the approval policy on the run. */
  readonly interactionPolicy: "interactive" | "headless"
  /** Optional agent ROLE to run a scheduled job as (e.g. "reviewer"). */
  readonly agent?: string
  /** Optional display title (e.g. the scheduled-run label in `:tree`). */
  readonly title?: string
}
