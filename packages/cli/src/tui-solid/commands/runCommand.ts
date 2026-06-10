import { Effect, Schema } from "effect"
import { ConversationId } from "@efferent/core"
import { emptyTree } from "../presentation/executionTree.js"
import { emptyStats } from "../presentation/sidePane.js"
import { SLASH_COMMANDS } from "../presentation/slashPalette.js"
import type { TuiContext } from "../state/store.js"
import {
  browseConversations,
  buildFromSelection,
  resumeConversation,
  toggleContext,
} from "../actions/session.js"
import { toggleTree } from "../actions/contextTree.js"
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
import { logout, openLoginFlow } from "../actions/login.js"

const decodeCid = Schema.decodeUnknown(ConversationId)
const newConversationId = (): ConversationId =>
  Effect.runSync(decodeCid(crypto.randomUUID()).pipe(Effect.orDie))

const HELP: ReadonlyArray<string> = [
  "Panes: Ctrl-h/j/k/l move focus (conversation · side · input) · z zoom",
  "Input: type a message, Shift-Enter sends (Alt-Enter too) · Enter newline · Esc interrupts a run",
  "Session: :clear :reset :handoff · :browse / :resume <#|id> switch conversations",
  "Context: :context opens the viewer (j/k move · Space pick · b build) · :build",
  "Model: :model picks a model · :effort thinking level · :search web-search config",
  "Providers: :login (subscription/OAuth or API key) · :logout <provider>",
  "Settings: :settings (table) · :set <key> <value> · :db [pg <url>|sqlite [path]]",
  "Commands (type ':'): :help :cwd :exit",
  "Quit: Ctrl-C",
]

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
    store.toast(`unknown command: ${rawName} (try :help)`)
    return
  }

  switch (cmd.name) {
    case ":exit":
    case ":quit":
      ctx.exit()
      return
    case ":clear":
      store.clear()
      return
    case ":help":
      for (const l of HELP) store.pushBlock({ kind: "info", text: l })
      store.pushBlock({ kind: "info", text: store.footer() })
      return
    case ":cwd":
      store.pushBlock({ kind: "info", text: store.status().cwd })
      return
    case ":reset": {
      store.run.newConversation(newConversationId())
      store.clear()
      store.setProjection((p) => ({
        ...p,
        tree: emptyTree,
        filesChanged: [],
        stats: { ...emptyStats, startedAt: Date.now(), contextWindow: p.stats.contextWindow },
      }))
      store.pushBlock({
        kind: "info",
        text: `new conversation: ${store.run.getConversationId().slice(0, 8)}`,
      })
      return
    }
    case ":context":
      void ctx.run(toggleContext(store, store.run.getConversationId()))
      return
    case ":tree":
      void ctx.run(toggleTree(store, store.run.getConversationId()))
      return
    case ":build":
      void ctx.run(buildFromSelection(store, store.status().cwd))
      return
    case ":browse":
      void ctx.run(browseConversations(store, store.status().cwd))
      return
    case ":resume":
      resume(ctx, arg)
      return
    case ":handoff":
      if (store.busy()) {
        store.pushBlock({ kind: "info", text: "can't hand off while a turn is running" })
        return
      }
      void ctx.run(runHandoff(store, store.run.getConversationId()))
      return
    case ":model":
      void ctx.run(openModelPicker(store))
      return
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
    case ":logout":
      void ctx.run(logout(store, arg))
      return
    case ":settings":
      void ctx.run(openSettingsView(store))
      return
    case ":set": {
      const rest = arg ?? ""
      const sp = rest.indexOf(" ")
      const k = sp === -1 ? rest : rest.slice(0, sp)
      const v = sp === -1 ? "" : rest.slice(sp + 1).trim()
      if (k.length === 0 || v.length === 0) {
        store.pushBlock({ kind: "error", text: "Usage: :set <key> <value> (e.g. :set maxSteps 15)" })
        return
      }
      void ctx.run(applySetting(store, k, v))
      return
    }
    case ":db":
      void ctx.run(applyDb(store, store.status().cwd, arg === undefined ? [] : arg.split(/\s+/).filter((t) => t.length > 0)))
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
  void ctx.run(resumeConversation(store, target.value))
}
