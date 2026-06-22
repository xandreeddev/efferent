import { Effect, Schema } from "effect"
import { ConversationId } from "@xandreed/sdk-core"
import { emptyTree } from "../presentation/executionTree.js"
import { emptyStats } from "../presentation/sidePane.js"
import { SLASH_COMMANDS } from "../presentation/slashPalette.js"
import type { TuiContext } from "../state/store.js"
import {
  openResumeBrowser,
  resumeConversation,
} from "../actions/session.js"
import { focusFleetTree, refreshNav } from "../actions/contextTree.js"
import { runHandoff } from "../actions/handoff.js"
import { openModelPicker } from "../actions/model.js"
import { applyTheme, openThemePicker } from "../actions/theme.js"
import {
  applyDb,
  applySetting,
  openEffortPicker,
  openSearchPicker,
  openSettingsView,
} from "../actions/settings.js"
import { logout, openLoginFlow, openLogoutPicker } from "../actions/login.js"
import { openOnboardingFlow } from "../actions/onboarding.js"
import { openConversationTraces, openFleetDashboard } from "../actions/observability.js"
import { parseDirective } from "../../usecases/directive.js"
import {
  addJob,
  loadJobs,
  parseScheduleArg,
  removeJob,
  type ScheduledJob,
} from "../../usecases/schedule.js"

const decodeCid = Schema.decodeUnknown(ConversationId)
const newConversationId = (): ConversationId =>
  Effect.runSync(decodeCid(crypto.randomUUID()).pipe(Effect.orDie))

/** Resolve a typed command name to a command by exact match or unique prefix. */
const resolve = (rawName: string) => {
  const exact = SLASH_COMMANDS.find((c) => c.name === rawName)
  if (exact !== undefined) return exact
  const matches = SLASH_COMMANDS.filter((c) => c.name.startsWith(rawName))
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Execute a `:` command line. Self-contained commands run inline; conversation
 * commands (`:context`/`:build`/`:browse`/`:resume`/`:handoff`) fork their lifted
 * Effect via `ctx.run` (fire-and-forget — the actions own their own busy flag and
 * error handling, so `ctx.run` never rejects). The overlay commands
 * (`:login`/`:model`/`:settings`/…) land in later phases — unknown-here ones say
 * so rather than failing silently.
 */
export const runCommand = (ctx: TuiContext, line: string): void => {
  const { store } = ctx
  const trimmed = line.trim()
  const space = trimmed.indexOf(" ")
  const rawName = space === -1 ? trimmed : trimmed.slice(0, space)
  const arg = space === -1 ? undefined : trimmed.slice(space + 1).trim()
  store.setInput("")

  const cmd = resolve(rawName)
  if (cmd === undefined) {
    store.toast(`unknown command: ${rawName} (type : for the palette, ? for keys)`)
    return
  }

  switch (cmd.name) {
    case ":exit":
    case ":quit":
      ctx.exit()
      return
    case ":clear": {
      store.run.newConversation(newConversationId())
      store.clear()
      store.setProjection((p) => ({
        ...p,
        tree: emptyTree,
        filesChanged: [],
        plan: [],
        stats: { ...emptyStats, startedAt: Date.now(), contextWindow: p.stats.contextWindow },
      }))
      store.pushBlock({
        kind: "info",
        text: `new conversation: ${store.run.getConversationId().slice(0, 8)}`,
      })
      return
    }
    case ":cwd":
      store.pushBlock({ kind: "info", text: store.status().cwd })
      return
    case ":shortcuts":
    case ":keys":
      store.setOverlay({ kind: "shortcuts" })
      return
    // ONE always-visible pane: the current session's fleet. `:tree` just moves
    // focus to it (Tab does too). (`:fleet` is the orchestration text summary.)
    case ":tree":
      void ctx.run(focusFleetTree(store, store.run.getConversationId()))
      return
    case ":sessions":
      store.pushBlock({
        kind: "info",
        text: "the fleet pane shows the CURRENT session only — switch sessions with :browse / :resume",
      })
      return
    case ":context":
    case ":build":
      store.pushBlock({
        kind: "info",
        text: "context curation (:context/:build) is deferred — the current session's fleet is on the right (Tab to focus)",
      })
      return
    case ":browse":
      // The agy tabbed resume browser: one tab per DB connection, each listing
      // that connection's conversations; Enter resumes (switching the live store
      // when the pick lives elsewhere). `:resume <id>` still resumes a raw id.
      void ctx.run(openResumeBrowser(store, store.status().cwd))
      return
    case ":resume":
      if (arg === undefined || arg.length === 0) void ctx.run(openResumeBrowser(store, store.status().cwd))
      else resume(ctx, arg)
      return
    case ":handoff":
      if (store.busy()) {
        store.pushBlock({ kind: "info", text: "can't hand off while a turn is running" })
        return
      }
      void ctx.run(runHandoff(store, store.run.getConversationId()))
      return
    case ":model": {
      // `:model` configures main; `:model fast` opens the same picker for the
      // fast helper role (leading "default (follow main)" row clears it).
      const role = arg?.trim().toLowerCase()
      if (arg !== undefined && role !== "fast" && !arg.includes(":")) {
        store.pushBlock({
          kind: "info",
          text: "Usage: :model [<provider>:<modelId>]  or  :model fast  to set the helper model",
        })
      }
      void ctx.run(openModelPicker(store, role === "fast" ? role : undefined))
      return
    }
    case ":effort":
      void ctx.run(openEffortPicker(store))
      return
    case ":search":
      void ctx.run(openSearchPicker(store))
      return
    case ":theme": {
      const name = arg?.trim()
      void ctx.run(name === undefined || name.length === 0 ? openThemePicker(store) : applyTheme(store, name))
      return
    }
    case ":login":
      void ctx.run(openLoginFlow(store))
      return
    case ":onboarding":
      void ctx.run(openOnboardingFlow(store))
      return
    case ":logout":
      // No provider → the agy contextual picker; an explicit name removes directly.
      void ctx.run(arg === undefined || arg.length === 0 ? openLogoutPicker(store) : logout(store, arg))
      return
    case ":settings":
      void ctx.run(openSettingsView(store))
      return
    case ":set": {
      const rest = arg ?? ""
      const sp = rest.indexOf(" ")
      const k = sp === -1 ? rest : rest.slice(0, sp)
      const v = sp === -1 ? "" : rest.slice(sp + 1).trim()
      // Bare `:set` is the menu front door — open the settings table (where every
      // knob is browsable + editable). A partial `:set <key>` with no value still
      // hints the direct form.
      if (k.length === 0) {
        void ctx.run(openSettingsView(store))
        return
      }
      if (v.length === 0) {
        store.pushBlock({ kind: "error", text: "Usage: :set <key> <value> (e.g. :set maxSteps 15) — or :set for the menu" })
        return
      }
      void ctx.run(applySetting(store, k, v))
      return
    }
    case ":db":
      void ctx.run(applyDb(store, store.status().cwd, arg === undefined ? [] : arg.split(/\s+/).filter((t) => t.length > 0)))
      return
    case ":spawn": {
      // Fire a named agent role from the live session: :spawn <agent> <folder> <task>
      const parts = arg === undefined ? [] : arg.split(/\s+/).filter((t) => t.length > 0)
      if (parts.length < 3) {
        store.pushBlock({
          kind: "info",
          text: "usage: :spawn <agent> <folder> <task>  (see :agents for roles)",
        })
        return
      }
      const [agent, folder, ...rest] = parts
      ctx.spawnAgent(agent!, folder!, rest.join(" "))
      return
    }
    case ":agents": {
      const sub = arg === undefined ? [] : arg.split(/\s+/).filter((t) => t.length > 0)
      if (sub[0] === "add") {
        if (sub[1] === undefined) {
          store.pushBlock({
            kind: "info",
            text: "usage: :agents add github:owner/repo[/path][@ref]",
          })
          return
        }
        ctx.importAgents(sub[1])
        return
      }
      if (ctx.roles.length === 0) {
        store.pushBlock({
          kind: "info",
          text: "no agent roles defined — add .efferent/agents/<name>.md, or :agents add github:owner/repo/path",
        })
        return
      }
      store.pushBlock({
        kind: "info",
        text:
          "agent roles:\n" +
          ctx.roles.map((r) => `  ${r.name} — ${r.description}`).join("\n") +
          "\nfire one with :spawn <agent> <folder> <task>",
      })
      return
    }
    case ":stop": {
      const running = ctx.listFleet()
      if (arg === undefined || arg.length === 0) {
        store.pushBlock({
          kind: "info",
          text:
            running.length === 0
              ? "no agents running"
              : "running agents:\n" +
                running.map((e) => `  ${e.id}: ${e.title} (${e.folder})`).join("\n") +
                "\nstop one with :stop <id>",
        })
        return
      }
      const id = Number(arg)
      if (!Number.isInteger(id)) {
        store.pushBlock({ kind: "info", text: "usage: :stop <id> (run :stop for running ids)" })
        return
      }
      ctx.stopAgent(id)
      store.pushBlock({ kind: "info", text: `stopping agent ${id}…` })
      return
    }
    case ":fleet": {
      // The orchestration cockpit snapshot: the standing goal (P4), the live
      // fired agents (P3/fleet), and this workspace's scheduled jobs (P5) — the
      // three persistent orchestration concerns, in one readout. (The header's
      // ◆ N agents chip tracks the live fleet continuously via the event pump;
      // :tree shows the full run tree.)
      const d = ctx.getDirective()
      const fired = ctx.listFleet()
      // The whole live fleet from the bus — model-spawned background agents
      // included, not just `:spawn`-fired ones.
      const live = ctx.liveAgents()
      void ctx.run(
        loadJobs().pipe(
          Effect.flatMap((jobs) =>
            Effect.sync(() => {
              const mine = jobs.filter((j) => j.cwd === store.status().cwd)
              const lines: Array<string> = ["── fleet ──"]
              lines.push(
                d === undefined
                  ? "directive: none (:goal <objective> to set)"
                  : `directive: ${d.objective}${d.criteria !== undefined ? ` — done when ${d.criteria}` : ""}`,
              )
              lines.push(
                live.length === 0
                  ? "running agents: none (ask for coding work, or :spawn <agent> <folder> <task>)"
                  : `running agents (${live.length}): ${live.map((a) => a.label).join(", ")}`,
              )
              if (fired.length > 0) {
                lines.push(`  fired (:stop <id>): ${fired.map((f) => `#${f.id} ${f.title}`).join(", ")}`)
              }
              lines.push(
                mine.length === 0
                  ? "scheduled: none (:schedule add …)"
                  : `scheduled: ${mine.map((j) => `${j.cron} → ${j.prompt}`).join(" · ")}`,
              )
              lines.push("verbs: :spawn · :stop <id> · :goal · :verify · :schedule · :tree · :agents · :tools")
              store.pushBlock({ kind: "info", text: lines.join("\n") })
            }),
          ),
        ),
      )
      return
    }
    case ":schedule": {
      const a = arg ?? ""
      if (a.startsWith("add")) {
        const parsed = parseScheduleArg(a.replace(/^add\s+/, ""))
        if (parsed === undefined) {
          store.pushBlock({
            kind: "info",
            text: "usage: :schedule add <cron> :: <folder> :: <prompt> [:: <agent>]  (e.g. :schedule add 0 9 * * 1 :: . :: review open PRs)",
          })
          return
        }
        const job: ScheduledJob = {
          id: crypto.randomUUID(),
          cron: parsed.cron,
          cwd: store.status().cwd,
          folder: parsed.folder,
          prompt: parsed.prompt,
          ...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
          createdAt: Date.now(),
        }
        void ctx.run(
          addJob(job).pipe(
            Effect.flatMap(() =>
              Effect.sync(() =>
                store.pushBlock({
                  kind: "info",
                  text: `scheduled (${job.cron}): ${job.prompt}${job.agent !== undefined ? ` [${job.agent}]` : ""} — fires while efferent is open. :schedule to list · :schedule rm ${job.id.slice(0, 8)} to drop.`,
                }),
              ),
            ),
          ),
        )
        return
      }
      if (a.startsWith("rm") || a.startsWith("remove")) {
        const id = a.replace(/^(rm|remove)\s+/, "").trim()
        if (id.length === 0) {
          store.pushBlock({ kind: "info", text: "usage: :schedule rm <id>" })
          return
        }
        void ctx.run(
          loadJobs().pipe(
            Effect.flatMap((jobs) => {
              const match = jobs.find((j) => j.id === id || j.id.startsWith(id))
              if (match === undefined) {
                return Effect.sync(() =>
                  store.pushBlock({ kind: "info", text: `no scheduled job '${id}'` }),
                )
              }
              return removeJob(match.id).pipe(
                Effect.flatMap(() =>
                  Effect.sync(() =>
                    store.pushBlock({ kind: "info", text: `removed scheduled job: ${match.prompt}` }),
                  ),
                ),
              )
            }),
          ),
        )
        return
      }
      void ctx.run(
        loadJobs().pipe(
          Effect.flatMap((jobs) =>
            Effect.sync(() => {
              const mine = jobs.filter((j) => j.cwd === store.status().cwd)
              store.pushBlock({
                kind: "info",
                text:
                  mine.length === 0
                    ? "no scheduled jobs — :schedule add <cron> :: <folder> :: <prompt>"
                    : "scheduled jobs (this workspace):\n" +
                      mine
                        .map(
                          (j) =>
                            `  ${j.id.slice(0, 8)}  ${j.cron}  ${j.folder}  ${j.prompt}${j.agent !== undefined ? ` [${j.agent}]` : ""}`,
                        )
                        .join("\n"),
              })
            }),
          ),
        ),
      )
      return
    }
    case ":tools": {
      const sub = arg === undefined ? [] : arg.split(/\s+/).filter((t) => t.length > 0)
      if (sub[0] === "add") {
        if (sub[1] === undefined) {
          store.pushBlock({ kind: "info", text: "usage: :tools add github:owner/repo[/path][@ref]" })
          return
        }
        ctx.importTools(sub[1])
        return
      }
      if (ctx.tools.length === 0) {
        store.pushBlock({
          kind: "info",
          text: "no custom tools — add .efferent/tools/<name>.md, or :tools add github:owner/repo/path",
        })
        return
      }
      store.pushBlock({
        kind: "info",
        text:
          "custom tools (run_tool):\n" +
          ctx.tools
            .map((t) => `  ${t.name}(${t.params.map((p) => p.name).join(", ")}) — ${t.description}`)
            .join("\n"),
      })
      return
    }
    case ":goal": {
      if (arg === undefined || arg.length === 0) {
        const d = ctx.getDirective()
        store.pushBlock({
          kind: "info",
          text:
            d === undefined
              ? "no directive set — :goal <objective> [:: done-when criteria]"
              : `directive: ${d.objective}${d.criteria !== undefined ? `\ndone when: ${d.criteria}` : ""} (:verify to check · :goal clear to drop)`,
        })
        return
      }
      if (arg.trim() === "clear") {
        ctx.setDirective(undefined)
        store.pushBlock({ kind: "info", text: "directive cleared" })
        return
      }
      const d = parseDirective(arg)
      if (d === undefined) {
        store.pushBlock({ kind: "info", text: "usage: :goal <objective> [:: done-when criteria]" })
        return
      }
      ctx.setDirective(d)
      store.pushBlock({
        kind: "info",
        text: `directive set — pursued every turn until :verify confirms it.\n${d.objective}${d.criteria !== undefined ? `\ndone when: ${d.criteria}` : ""}`,
      })
      return
    }
    case ":verify": {
      const d = ctx.getDirective()
      const adhoc = arg !== undefined && arg.length > 0
      const objective = adhoc ? arg! : d?.objective
      if (objective === undefined) {
        store.pushBlock({
          kind: "info",
          text: "nothing to verify — set a goal (:goal <objective>) or :verify <objective>",
        })
        return
      }
      const criteria = adhoc ? undefined : d?.criteria
      const task =
        `Verify whether this objective is genuinely met:\n${objective}` +
        (criteria !== undefined ? `\nAcceptance: ${criteria}` : "") +
        `\n\nRead the workspace, check it independently, and report MET / NOT MET / INCONCLUSIVE with concrete evidence.`
      ctx.spawnAgent("verifier", ".", task)
      return
    }
    case ":traces":
      void ctx.run(openConversationTraces(store, store.run.getConversationId()))
      return
    case ":dashboard":
      void ctx.run(openFleetDashboard(store))
      return
    default:
      store.pushBlock({
        kind: "info",
        text: `${cmd.name} is not available in the OpenTUI TUI yet (coming in a later phase)`,
      })
      return
  }
}

/** `:resume <#|id>` — resolve a numbered `:browse` pick or a raw id, then switch. */
const resume = (ctx: TuiContext, arg: string | undefined): void => {
  const { store } = ctx
  if (store.busy()) {
    store.pushBlock({ kind: "info", text: "can't resume while a turn is running" })
    return
  }
  if (arg === undefined || arg.length === 0) {
    store.pushBlock({ kind: "info", text: "usage: :resume <#|id> (run :browse first)" })
    return
  }
  const n = Number(arg)
  const list = store.run.getBrowseList()
  const rawId =
    Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1]!.id : arg
  const target = Effect.runSync(decodeCid(rawId).pipe(Effect.option))
  if (target._tag === "None") {
    store.pushBlock({ kind: "info", text: `not a conversation: ${arg}` })
    return
  }
  // The navigator (agents/sessions views) keys off the active conversation —
  // without a refresh its root row keeps the PREVIOUS session's label.
  void ctx.run(
    resumeConversation(store, target.value).pipe(
      Effect.zipRight(refreshNav(store, target.value).pipe(Effect.catchAll(() => Effect.void))),
    ),
  )
}
