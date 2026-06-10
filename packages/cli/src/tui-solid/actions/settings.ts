import { homedir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  AuthStore,
  DEFAULT_SUB_AGENT_TOKEN_BUDGET,
  FileSystem,
  ModelRegistry,
  SettingsStore,
  effortLevelsFor,
  effortSettingKeyFor,
  maskDbUrl,
} from "@efferent/core"
import { openSelect, type SelectOption } from "../presentation/selectBox.js"
import { describeActiveDatabase } from "../presentation/dbStatus.js"
import { openSettings, setRowValue, type SettingsRow } from "../presentation/settingsView.js"
import type { EffortSettingKey } from "../state/overlay.js"
import type { TuiStore } from "../state/store.js"

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
      { key: "database", label: "database", value: db.value, kind: "readonly", hint: "use :db" },
    ]
    yield* Effect.sync(() => store.setOverlay({ kind: "settings", state: openSettings(rows) }))
  })

/** Reflect a committed value into the open settings overlay (preserving cursor). */
const reflectRow = (store: TuiStore, key: string, value: string): void => {
  const o = store.overlay()
  if (o.kind === "settings") store.setOverlay({ kind: "settings", state: setRowValue(o.state, key, value) })
}

/** Toggle the boolean `allowBash` row + persist. */
export const toggleAllowBash = (store: TuiStore, currentValue: string) =>
  Effect.gen(function* () {
    const next = currentValue !== "true"
    yield* (yield* SettingsStore).update((curr) => ({ ...curr, allowBash: next }))
    yield* Effect.sync(() => reflectRow(store, "allowBash", String(next)))
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
    yield* err(
      `Unknown setting: ${key}. Valid: allowBash, maxSteps, anthropicThinkingEffort, openAiReasoningEffort, geminiThinkingLevel, searchModel`,
    )
  })

// --- :db ---------------------------------------------------------------------

/** `:db` — show the active store, or write a new `dbUrl` to project/global config. */
export const applyDb = (store: TuiStore, cwd: string, tokens: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const wantGlobal = tokens.some((t) => t.toLowerCase() === "global")
    const args = tokens.filter((t) => t.toLowerCase() !== "global")

    if (args.length === 0) {
      const current = yield* (yield* SettingsStore).get()
      const db = describeActiveDatabase(process.env["EFFERENT_DB_URL"], current.dbUrl)
      yield* Effect.sync(() => {
        store.pushBlock({ kind: "info", text: db.line })
        if (db.overrideNote !== undefined) store.pushBlock({ kind: "info", text: db.overrideNote })
        store.pushBlock({
          kind: "info",
          text: "set: :db pg <url> [global] · :db sqlite [path] [global] (applies next launch)",
        })
      })
      return
    }

    const head = args[0]!.toLowerCase()
    let dbUrl: string // "" → reset to default SQLite
    if (head === "sqlite") {
      dbUrl = args[1] ?? ""
    } else if (head === "pg" || head === "postgres" || head === "postgresql") {
      dbUrl = args.slice(1).join(" ").trim()
      if (dbUrl.length === 0) {
        yield* Effect.sync(() =>
          store.pushBlock({ kind: "error", text: "Usage: :db pg <postgres://… connection string> [global]" }),
        )
        return
      }
    } else {
      dbUrl = args.join(" ").trim()
    }

    const fs = yield* FileSystem
    const cfgPath = wantGlobal
      ? join(homedir(), ".efferent", "config.json")
      : join(cwd, ".efferent", "config.json")
    const exists = yield* fs.exists(cfgPath).pipe(Effect.orElseSucceed(() => false))
    let cfg: Record<string, unknown> = {}
    if (exists) {
      const read = yield* fs.read(cfgPath).pipe(Effect.either)
      if (read._tag === "Right") {
        try {
          cfg = JSON.parse(read.right.content) as Record<string, unknown>
        } catch {
          /* overwrite malformed config */
        }
      }
    }
    if (dbUrl.length > 0) cfg["dbUrl"] = dbUrl
    else delete cfg["dbUrl"]
    const writeResult = yield* fs.write(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`).pipe(Effect.either)

    yield* Effect.sync(() => {
      if (writeResult._tag === "Left") {
        store.pushBlock({ kind: "error", text: `Failed to write ${cfgPath}: ${String(writeResult.left)}` })
        return
      }
      const scope = wantGlobal ? "global (~/.efferent)" : "project (.efferent)"
      const target = dbUrl.length > 0 ? maskDbUrl(dbUrl) : "SQLite default (~/.efferent/efferent.db)"
      store.pushBlock({
        kind: "info",
        text: `database → ${target} · saved to ${scope} config · relaunch efferent to connect`,
      })
    })
  })
