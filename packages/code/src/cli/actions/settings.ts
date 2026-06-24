import { homedir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  activeConnName,
  type AgentMessage,
  DEFAULT_AUTO_HANDOFF_PCT,
  AuthStore,
  type Checkpoint,
  type ConfigScope,
  configuredConns,
  connFromUrl,
  connLabel,
  ConversationStore,
  type DatabaseConn,
  DEFAULT_SUB_AGENT_TOKEN_BUDGET,
  LOCAL_DB_NAME,
  ModelRegistry,
  type NamedConn,
  SettingsStore,
  StoreSwitch,
  suggestName,
  effortLevelsFor,
  effortSettingKeyFor,
} from "@xandreed/sdk-core"
import { DEFAULT_SUB_AGENT_MAX_STEPS } from "../../usecases/buildScopeRuntime.js"
import { openSelect, type SelectOption } from "../presentation/selectBox.js"
import { rolesReadout } from "../presentation/statusBar.js"
import { openSettings, setRowValue, type SettingsRow } from "../presentation/settingsView.js"
import { describeActiveDatabase } from "../presentation/dbStatus.js"
import { resumeConversation } from "./session.js"
import { refreshNav } from "./contextTree.js"
import type { EffortSettingKey } from "../state/overlay.js"
import type { TuiStore } from "../state/store.js"

/** The zero-config local SQLite path (adapters' default when dbUrl is unset). */
const dbLocalPath = join(homedir(), ".efferent", "efferent.db")

// Web-search defaults (mirrors `tui.ts`); the picker only offers a provider
// whose credential is present, plus the auto default.
const DEFAULT_GOOGLE_SEARCH_MODEL = "google:gemini-3.5-flash"
const DEFAULT_OPENAI_SEARCH_MODEL = "openai:gpt-4o"

/** Open the thinking-effort picker for the active model's provider, if it has one. */
export const openEffortPicker = (store: TuiStore) =>
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    const cur = yield* registry.current
    const levels = effortLevelsFor(cur.provider, cur.modelId)
    const key = effortSettingKeyFor(cur.provider)
    if (levels === undefined || key === undefined) {
      yield* Effect.sync(() =>
        store.pushBlock({
          kind: "info",
          text: `${cur.provider} models don't support a thinking effort setting`,
        }),
      )
      return
    }
    const settings = yield* (yield* SettingsStore).get()
    const currentVal = (settings[key] as string | undefined) ?? ""
    const options: ReadonlyArray<SelectOption<string>> = levels.map((level) => ({
      value: level,
      label: level.length === 0 ? "default" : level,
      active: level === currentVal,
    }))
    yield* Effect.sync(() =>
      store.setOverlay({
        kind: "select",
        sel: openSelect("Select thinking effort", options),
        purpose: { tag: "effort", key },
      }),
    )
  })

/** Persist the chosen effort level and reflect it in the status bar. */
export const applyEffort = (store: TuiStore, key: EffortSettingKey, level: string) =>
  Effect.gen(function* () {
    const next = level.length === 0 ? undefined : level
    const settings = yield* SettingsStore
    yield* settings.update((curr) => ({ ...curr, [key]: next }))
    yield* Effect.sync(() => store.setStatus({ effort: next }))
  })

/** Open the web-search config picker (default + each logged-in provider's tool). */
export const openSearchPicker = (store: TuiStore) =>
  Effect.gen(function* () {
    const settings = yield* (yield* SettingsStore).get()
    const configured = settings.searchModel
    const auth = yield* (yield* AuthStore).all
    const options: ReadonlyArray<SelectOption<string | undefined>> = [
      {
        value: undefined,
        label: "default (auto: env → Google Search → OpenAI Web Search)",
        active: configured === undefined,
      },
      ...(auth.google !== undefined
        ? [
            {
              value: DEFAULT_GOOGLE_SEARCH_MODEL,
              label: "Google Search grounding (Gemini)",
              active: configured === DEFAULT_GOOGLE_SEARCH_MODEL,
            },
          ]
        : []),
      ...(auth.openai?.type === "api_key"
        ? [
            {
              value: DEFAULT_OPENAI_SEARCH_MODEL,
              label: "OpenAI Web Search",
              active: configured === DEFAULT_OPENAI_SEARCH_MODEL,
            },
          ]
        : []),
    ]
    yield* Effect.sync(() =>
      store.setOverlay({
        kind: "select",
        sel: openSelect("Select web search config", options),
        purpose: { tag: "search" },
      }),
    )
  })

/** Persist the web-search config (drop the key for the auto default). */
export const applySearchModel = (store: TuiStore, chosen: string | undefined) =>
  Effect.gen(function* () {
    const settings = yield* SettingsStore
    yield* settings.update((curr) => {
      if (chosen === undefined) {
        const { searchModel: _drop, ...rest } = curr
        return rest
      }
      return { ...curr, searchModel: chosen }
    })
    yield* Effect.sync(() =>
      store.toast(`searchModel → ${chosen ?? "default"}`),
    )
  })

// --- :settings table overlay -------------------------------------------------

/** Build the settings rows and open the `:settings` table overlay. */
export const openSettingsView = (store: TuiStore) =>
  Effect.gen(function* () {
    const current = yield* (yield* SettingsStore).get()
    const db = describeActiveDatabase(process.env["EFFERENT_DB_URL"], current.dbUrl)
    const rows: ReadonlyArray<SettingsRow> = [
      { key: "allowBash", label: "allowBash", value: String(current.allowBash), kind: "boolean" },
      { key: "maxSteps", label: "maxSteps", value: String(current.maxSteps), kind: "number" },
      {
        key: "subAgentTokenBudget",
        label: "subAgentBudget",
        value: String(current.subAgentTokenBudget ?? DEFAULT_SUB_AGENT_TOKEN_BUDGET),
        kind: "readonly",
        hint: "use :set subAgentTokenBudget <n> (0 = off)",
      },
      {
        key: "subAgentMaxSteps",
        label: "subAgentSteps",
        value: String(current.subAgentMaxSteps ?? DEFAULT_SUB_AGENT_MAX_STEPS),
        kind: "readonly",
        hint: "use :set subAgentMaxSteps <n>",
      },
      {
        key: "anthropicThinkingEffort",
        label: "claudeThink",
        value: current.anthropicThinkingEffort ?? "",
        kind: "enum",
        options: ["", "off", "low", "medium", "high"],
        hint: "default/off/low/medium/high",
      },
      {
        key: "openAiReasoningEffort",
        label: "openaiReason",
        value: current.openAiReasoningEffort ?? "",
        kind: "enum",
        options: ["", "none", "minimal", "low", "medium", "high"],
        hint: "default/none/minimal/low/medium/high",
      },
      {
        key: "geminiThinkingLevel",
        label: "geminiThink",
        value: current.geminiThinkingLevel ?? "",
        kind: "enum",
        options: ["", "off", "minimal", "low", "medium", "high"],
        hint: "default/off/minimal/low/medium/high",
      },
      { key: "model", label: "model", value: current.model, kind: "readonly", hint: "use :model" },
      {
        key: "searchModel",
        label: "searchModel",
        value: current.searchModel ?? "default",
        kind: "readonly",
        hint: "use :search",
      },
      {
        key: "fastModel",
        label: "fastModel",
        value: current.fastModel ?? "default (main)",
        kind: "readonly",
        hint: "use :model fast",
      },
      {
        key: "toolResultMaxTokens",
        label: "toolResultMax",
        value: String(current.toolResultMaxTokens ?? 4000),
        kind: "readonly",
        hint: "compaction clip budget (0 = off)",
      },
      {
        key: "autoHandoffPct",
        label: "autoHandoff",
        value: `${current.autoHandoffPct ?? DEFAULT_AUTO_HANDOFF_PCT}%`,
        kind: "readonly",
        hint: "auto-fold threshold (0 = off)",
      },
      {
        key: "autoApprove",
        label: "autoApprove",
        value: String(current.autoApprove ?? true),
        kind: "boolean",
        hint: "fast judge waves through in-folder work",
      },
      {
        key: "autoCollapse",
        label: "autoCollapse",
        value: String(current.autoCollapse ?? false),
        kind: "boolean",
        hint: "sending folds the previous turns",
      },
      {
        key: "telemetry",
        label: "telemetry",
        value: String(current.telemetry ?? false),
        kind: "boolean",
        hint: "OTLP traces+metrics (+ LLM prompt/completion) → Grafana (next launch; run obs:up)",
      },
      { key: "database", label: "database", value: db.value, kind: "readonly", hint: "use :db" },
    ]
    yield* Effect.sync(() => store.setOverlay({ kind: "settings", state: openSettings(rows) }))
  })

/** Reflect a committed value into the open settings overlay (preserving cursor). */
const reflectRow = (store: TuiStore, key: string, value: string): void => {
  const o = store.overlay()
  if (o.kind === "settings") store.setOverlay({ kind: "settings", state: setRowValue(o.state, key, value) })
}

/** Toggle a boolean settings row (`allowBash`, `autoApprove`, `autoCollapse`, `telemetry`) + persist. */
export const toggleBooleanSetting = (store: TuiStore, key: string, currentValue: string) =>
  Effect.gen(function* () {
    const next = currentValue !== "true"
    yield* (yield* SettingsStore).update((curr) => ({ ...curr, [key]: next }))
    yield* Effect.sync(() => reflectRow(store, key, String(next)))
  })

/** Cycle an enum row to `next` (empty → provider default) + persist. */
export const cycleEnumSetting = (store: TuiStore, key: string, next: string) =>
  Effect.gen(function* () {
    yield* (yield* SettingsStore).update((curr) => ({
      ...curr,
      [key]: next.length === 0 ? undefined : next,
    }))
    yield* Effect.sync(() => reflectRow(store, key, next))
  })

/** Commit an inline `maxSteps` number edit (already validated ≥ 1) + persist. */
export const commitMaxSteps = (store: TuiStore, n: number) =>
  Effect.gen(function* () {
    yield* (yield* SettingsStore).update((curr) => ({ ...curr, maxSteps: n }))
    yield* Effect.sync(() => reflectRow(store, "maxSteps", String(n)))
  })

// --- :set <key> <value> ------------------------------------------------------

const SEARCH_RE = /^(google|openai):/
const parseSearchModelArg = (raw: string): string | undefined => {
  const value = raw.trim()
  if (value.length === 0 || value === "default") return undefined
  if (value.includes(":") && !SEARCH_RE.test(value)) return undefined
  return SEARCH_RE.test(value) ? value : undefined
}

const ENUM_ALLOWED: Record<string, ReadonlyArray<string>> = {
  anthropicThinkingEffort: ["default", "off", "low", "medium", "high"],
  openAiReasoningEffort: ["default", "none", "minimal", "low", "medium", "high"],
  geminiThinkingLevel: ["default", "off", "minimal", "low", "medium", "high"],
}

/** `:set <key> <value>` — validate, persist, confirm. Lifted from `tui.ts`. */
export const applySetting = (store: TuiStore, key: string, value: string) =>
  Effect.gen(function* () {
    const settings = yield* SettingsStore
    const err = (text: string) => Effect.sync(() => store.pushBlock({ kind: "error", text }))

    if (key === "maxSteps") {
      const num = Number(value)
      if (!Number.isFinite(num) || num < 1) return yield* err("Setting 'maxSteps' must be a number ≥ 1")
      yield* settings.update((curr) => ({ ...curr, maxSteps: Math.floor(num) }))
      yield* Effect.sync(() => store.toast(`Updated maxSteps → ${Math.floor(num)}`))
      return
    }
    if (key === "allowBash") {
      if (value !== "true" && value !== "false") return yield* err("Setting 'allowBash' must be 'true' or 'false'")
      yield* settings.update((curr) => ({ ...curr, allowBash: value === "true" }))
      yield* Effect.sync(() => store.toast(`Updated allowBash → ${value}`))
      return
    }
    if (key === "autoApprove") {
      const on = value === "true" || value === "on"
      const off = value === "false" || value === "off"
      if (!on && !off) return yield* err("Setting 'autoApprove' must be 'on' or 'off'")
      yield* settings.update((curr) => ({ ...curr, autoApprove: on }))
      yield* Effect.sync(() => {
        store.toast(`Updated autoApprove → ${on ? "on" : "off (every unmatched command prompts)"}`)
        reflectRow(store, "autoApprove", String(on))
      })
      return
    }
    if (key === "autoCollapse") {
      const on = value === "true" || value === "on"
      const off = value === "false" || value === "off"
      if (!on && !off) return yield* err("Setting 'autoCollapse' must be 'on' or 'off'")
      yield* settings.update((curr) => ({ ...curr, autoCollapse: on }))
      yield* Effect.sync(() => {
        store.toast(`Updated autoCollapse → ${on ? "on (sending folds previous turns)" : "off"}`)
        reflectRow(store, "autoCollapse", String(on))
      })
      return
    }
    if (key === "telemetry") {
      const on = value === "true" || value === "on"
      const off = value === "false" || value === "off"
      if (!on && !off) return yield* err("Setting 'telemetry' must be 'on' or 'off'")
      yield* settings.update((curr) => ({ ...curr, telemetry: on }))
      yield* Effect.sync(() => {
        // The OTLP tracer is composed at boot (like the db store), so the export
        // toggle takes effect on the next launch — say so rather than imply live.
        store.toast(
          on
            ? "Updated telemetry → on · OTLP export starts next launch (run obs:up; traces in Grafana)"
            : "Updated telemetry → off · applies next launch",
        )
        reflectRow(store, "telemetry", String(on))
      })
      return
    }
    if (key === "subAgentTokenBudget") {
      const num = Number(value)
      if (!Number.isFinite(num) || num < 0) {
        return yield* err("Setting 'subAgentTokenBudget' must be a number ≥ 0 (0 disables the cap)")
      }
      yield* settings.update((curr) => ({ ...curr, subAgentTokenBudget: Math.floor(num) }))
      yield* Effect.sync(() =>
        store.pushBlock({
          kind: "info",
          text: `Updated subAgentTokenBudget → ${num === 0 ? "off" : Math.floor(num)}`,
        }),
      )
      return
    }
    if (key === "subAgentMaxSteps") {
      const num = Number(value)
      if (!Number.isFinite(num) || num < 1) {
        return yield* err("Setting 'subAgentMaxSteps' must be a number ≥ 1")
      }
      yield* settings.update((curr) => ({ ...curr, subAgentMaxSteps: Math.floor(num) }))
      yield* Effect.sync(() => store.toast(`Updated subAgentMaxSteps → ${Math.floor(num)}`))
      return
    }
    if (key in ENUM_ALLOWED) {
      const allowed = ENUM_ALLOWED[key]!
      if (!allowed.includes(value)) return yield* err(`Setting '${key}' must be one of: ${allowed.join(", ")}`)
      const next = value === "default" ? undefined : value
      yield* settings.update((curr) => ({ ...curr, [key]: next }))
      yield* Effect.sync(() => store.toast(`Updated ${key} → ${next ?? "default"}`))
      return
    }
    if (key === "searchModel") {
      const parsed = parseSearchModelArg(value)
      if (value !== "default" && parsed === undefined) {
        return yield* err("Setting 'searchModel' must be 'default' or google/openai:<modelId>")
      }
      yield* settings.update((curr) => {
        if (parsed === undefined) {
          const { searchModel: _drop, ...rest } = curr
          return rest
        }
        return { ...curr, searchModel: parsed }
      })
      yield* Effect.sync(() => store.toast(`Updated searchModel → ${parsed ?? "default"}`))
      return
    }
    if (key === "toolResultMaxTokens") {
      const num = Number(value)
      if (!Number.isFinite(num) || num < 0) {
        return yield* err("Setting 'toolResultMaxTokens' must be a number ≥ 0 (0 disables compaction clipping)")
      }
      yield* settings.update((curr) => ({ ...curr, toolResultMaxTokens: Math.floor(num) }))
      yield* Effect.sync(() => {
        store.toast(`Updated toolResultMaxTokens → ${Math.floor(num)}${num === 0 ? " (clipping off)" : ""}`)
        reflectRow(store, "toolResultMaxTokens", String(Math.floor(num)))
      })
      return
    }
    if (key === "autoHandoffPct") {
      const num = Number(value)
      if (!Number.isFinite(num) || num < 0 || num > 99) {
        return yield* err("Setting 'autoHandoffPct' must be 0–99 (0 disables the auto-fold)")
      }
      yield* settings.update((curr) => ({ ...curr, autoHandoffPct: Math.floor(num) }))
      yield* Effect.sync(() => {
        store.toast(`Updated autoHandoffPct → ${Math.floor(num)}${num === 0 ? " (auto-fold off)" : "%"}`)
        reflectRow(store, "autoHandoffPct", String(Math.floor(num)))
      })
      return
    }
    if (key === "fastModel") {
      // The non-main role. Any logged-in provider works; require the explicit
      // '<provider>:<modelId>' form so a bare id can't silently land on the
      // wrong provider.
      const provider = value.includes(":") ? value.slice(0, value.indexOf(":")) : undefined
      const valid =
        value === "default" ||
        (provider !== undefined &&
          ["google", "openai", "anthropic", "opencode", "ollama"].includes(provider) &&
          value.length > provider.length + 1)
      if (!valid) {
        return yield* err(
          `Setting '${key}' must be 'default' or '<provider>:<modelId>' (google/openai/anthropic/opencode/ollama)`,
        )
      }
      yield* settings.update((curr) => {
        const next = { ...curr } as Record<string, unknown>
        if (value === "default") delete next["fastModel"]
        else next["fastModel"] = value
        return next as typeof curr
      })
      const updated = yield* settings.get()
      yield* Effect.sync(() => {
        store.setStatus({ roles: rolesReadout(updated) })
        store.toast(`Updated fastModel → ${value === "default" ? "default (main model)" : value}`)
        reflectRow(store, "fastModel", value === "default" ? "default (main)" : value)
      })
      return
    }
    if (key === "grafanaUrl") {
      // Base URL for the :traces / :dashboard deep links. 'default' clears it
      // (→ http://localhost:3000). Trailing slash trimmed so the URL builders
      // can append `/d/…` cleanly.
      const isUrl = /^https?:\/\/\S+$/.test(value)
      if (value !== "default" && !isUrl) {
        return yield* err("Setting 'grafanaUrl' must be a http(s):// URL, or 'default'")
      }
      yield* settings.update((curr) => {
        if (value === "default") {
          const { grafanaUrl: _drop, ...rest } = curr
          return rest
        }
        return { ...curr, grafanaUrl: value.replace(/\/+$/, "") }
      })
      yield* Effect.sync(() => store.toast(`Updated grafanaUrl → ${value === "default" ? "default (http://localhost:3000)" : value.replace(/\/+$/, "")}`))
      return
    }
    yield* err(
      `Unknown setting: ${key}. Valid: allowBash, maxSteps, subAgentTokenBudget, subAgentMaxSteps, anthropicThinkingEffort, openAiReasoningEffort, geminiThinkingLevel, searchModel, fastModel, toolResultMaxTokens, autoHandoffPct, autoApprove, autoCollapse, telemetry, grafanaUrl`,
    )
  })

// --- :db ---------------------------------------------------------------------

/**
 * Make `conn` the active database LIVE (no restart): switch the store (running
 * pending migrations), persist the default (+ save the connection when `persist`
 * is set), and **carry the current conversation across** by copying its messages
 * + checkpoints + title into the new store (rows are never moved between DBs).
 * Refused mid-turn. The original conversation stays intact in its own DB.
 */
const switchActiveDatabase = (
  store: TuiStore,
  name: string,
  conn: DatabaseConn,
  cwd: string,
  persist?: { readonly scope: ConfigScope },
) =>
  Effect.gen(function* () {
    if (store.busy()) {
      yield* Effect.sync(() => store.toast("can't switch database mid-turn"))
      return
    }
    const cs = yield* ConversationStore
    const curId = store.run.getConversationId()
    // Snapshot the current conversation from the CURRENT store, before switching.
    const msgs = yield* cs
      .list(curId)
      .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<AgentMessage>)))
    const cps = yield* cs
      .listCheckpoints(curId)
      .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<Checkpoint>)))
    const ws = yield* cs.listByWorkspace(cwd).pipe(Effect.catchAll(() => Effect.succeed([])))
    const title = ws.find((c) => c.id === curId)?.title

    yield* Effect.sync(() => store.setNote(`connecting to ${name}…`))
    const res = yield* (yield* StoreSwitch).switchTo(name, conn, cwd).pipe(Effect.either)
    if (res._tag === "Left") {
      yield* Effect.sync(() => store.setNote(`couldn't switch to ${name}: ${res.left.message}`))
      return
    }
    // Active store is now `conn`. Persist the default (+ the connection itself).
    const isImplicitLocal = conn.kind === "sqlite" && conn.url === dbLocalPath && name === LOCAL_DB_NAME
    yield* (yield* SettingsStore).update((curr) => {
      const databases = { ...(curr.databases ?? {}) }
      if (persist !== undefined && !isImplicitLocal) databases[name] = { kind: conn.kind, url: conn.url }
      return { ...curr, databases, defaultDatabase: name }
    }, persist?.scope ?? "local")

    // Copy the current conversation into the new store (interleave checkpoints at
    // their original positions so handoff folds survive).
    const newId = yield* cs.create(cwd)
    const ordered = [...cps].sort((a, b) => a.messagePosition - b.messagePosition)
    let ci = 0
    for (let i = 0; i < msgs.length; i++) {
      yield* cs.append(newId, msgs[i]!).pipe(Effect.catchAll(() => Effect.void))
      while (ci < ordered.length && ordered[ci]!.messagePosition === i) {
        yield* cs.checkpoint(newId, ordered[ci]!.summary).pipe(Effect.catchAll(() => Effect.void))
        ci++
      }
    }
    while (ci < ordered.length) {
      yield* cs.checkpoint(newId, ordered[ci]!.summary).pipe(Effect.catchAll(() => Effect.void))
      ci++
    }
    if (title !== undefined) yield* cs.setTitle(newId, title).pipe(Effect.catchAll(() => Effect.void))

    yield* Effect.sync(() => {
      store.run.newConversation(newId)
      store.setStatus({ storage: connLabel(name, conn.kind) })
    })
    yield* resumeConversation(store, newId)
    yield* refreshNav(store, newId).pipe(Effect.catchAll(() => Effect.void))
    yield* Effect.sync(() => {
      store.setNote(undefined)
      store.toast(
        msgs.length > 0
          ? `switched to ${name} — carried over ${msgs.length} message${msgs.length === 1 ? "" : "s"}`
          : `switched to ${name}`,
      )
    })
  })

/** `:db` with no args — the manager picker: every configured connection with the
 *  default marked, plus a hint for add/remove (which are command forms). */
export const openDbManager = (store: TuiStore, cwd: string) =>
  Effect.gen(function* () {
    const settings = yield* (yield* SettingsStore).get()
    const conns = configuredConns(settings.databases, dbLocalPath)
    const active = activeConnName(settings.defaultDatabase)
    const options: ReadonlyArray<SelectOption<NamedConn>> = conns.map((c) => ({
      value: c,
      label: c.name === active ? `${connLabel(c.name, c.kind)}  ◀ default` : connLabel(c.name, c.kind),
      active: c.name === active,
    }))
    yield* Effect.sync(() => {
      store.pushBlock({
        kind: "info",
        text: "add: :db pg <url> · :db sqlite [path] · remove: :db remove <name>",
      })
      store.setOverlay({ kind: "select", sel: openSelect("Switch database", options), purpose: { tag: "database" } })
    })
  })

/** Picker submit — make the chosen existing connection the active default. */
export const applyDatabasePick = (store: TuiStore, conn: NamedConn, cwd: string) =>
  switchActiveDatabase(store, conn.name, { kind: conn.kind, url: conn.url }, cwd)

/**
 * `:db` — no args opens the manager picker; `:db pg <url>` / `:db sqlite [path]`
 * add a named connection and switch to it live; `:db remove <name>` drops one.
 * `[global]` targets the machine tier (default local). Connections are saved in
 * `Settings.databases` and applied immediately — no relaunch.
 */
export const applyDb = (store: TuiStore, cwd: string, tokens: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const wantGlobal = tokens.some((t) => t.toLowerCase() === "global")
    const scope: ConfigScope = wantGlobal ? "global" : "local"
    const args = tokens.filter((t) => t.toLowerCase() !== "global")

    if (args.length === 0) {
      yield* openDbManager(store, cwd)
      return
    }

    const head = args[0]!.toLowerCase()

    if (head === "remove" || head === "rm") {
      const name = args[1]
      if (name === undefined) {
        yield* Effect.sync(() => store.pushBlock({ kind: "error", text: "Usage: :db remove <name>" }))
        return
      }
      const settingsStore = yield* SettingsStore
      const settings = yield* settingsStore.get()
      if (settings.databases?.[name] === undefined) {
        yield* Effect.sync(() => store.toast(`no database named ${name}`))
        return
      }
      yield* settingsStore.update((curr) => {
        const databases = { ...(curr.databases ?? {}) }
        delete databases[name]
        if (curr.defaultDatabase === name) {
          const { defaultDatabase: _drop, ...rest } = curr
          return { ...rest, databases }
        }
        return { ...curr, databases }
      }, scope)
      yield* Effect.sync(() => store.toast(`removed database ${name}`))
      return
    }

    let conn: DatabaseConn
    if (head === "pg" || head === "postgres" || head === "postgresql") {
      const url = args.slice(1).join(" ").trim()
      if (url.length === 0) {
        yield* Effect.sync(() =>
          store.pushBlock({ kind: "error", text: "Usage: :db pg <postgres://… connection string> [global]" }),
        )
        return
      }
      conn = connFromUrl(url)
    } else if (head === "sqlite") {
      const path = args[1] ?? ""
      conn = { kind: "sqlite", url: path.length > 0 ? path : dbLocalPath }
    } else {
      const v = args.join(" ").trim()
      if (v.length === 0) {
        yield* openDbManager(store, cwd)
        return
      }
      conn = connFromUrl(v)
    }

    const isImplicitLocal = conn.kind === "sqlite" && conn.url === dbLocalPath
    const settings = yield* (yield* SettingsStore).get()
    const existing = [LOCAL_DB_NAME, ...Object.keys(settings.databases ?? {})]
    const name = isImplicitLocal ? LOCAL_DB_NAME : suggestName(conn, existing)
    yield* switchActiveDatabase(store, name, conn, cwd, { scope })
  })
