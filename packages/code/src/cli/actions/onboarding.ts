import { homedir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  activeConnName,
  AuthStore,
  type ConfigScope,
  configuredConns,
  connFromUrl,
  connLabel,
  LOCAL_DB_NAME,
  ModelRegistry,
  SettingsStore,
  StoreSwitch,
  suggestName,
  type AuthData,
  type ModelInfo,
} from "@xandreed/sdk-core"
import {
  onboardingToLogin,
  onboardingToMainModel,
  onboardingToFastModel,
  onboardingToTheme,
  onboardingToDatabase,
  databaseAdd,
  databaseEdit,
  onboardingToComplete,
  startOnboarding,
  type OnboardingState,
} from "../presentation/onboardingFlow.js"
import { selectedValue } from "../presentation/selectBox.js"
import { promptValue } from "../presentation/promptBox.js"
import { type ProviderStatus } from "../presentation/loginFlow.js"
import { rolesChip } from "../presentation/statusBar.js"
import { applyModelSelection } from "./model.js"
import { applyTheme } from "./theme.js"
import type { TuiStore } from "../state/store.js"

/** The zero-config local SQLite path (matches adapters' default when dbUrl is
 *  unset): SQLite at ~/.efferent/efferent.db. */
const defaultLocalPath = join(homedir(), ".efferent", "efferent.db")

const PROVIDERS = ["anthropic", "google", "openai", "opencode", "ollama"] as const

const loginStatuses = (auth: AuthData): ReadonlyArray<ProviderStatus> =>
  PROVIDERS.map((p) => ({ provider: p, configured: auth[p]?.type }))

export const openOnboardingFlow = (store: TuiStore) =>
  Effect.gen(function* () {
    const all = yield* (yield* AuthStore).all
    const statuses = loginStatuses(all)
    yield* Effect.sync(() => {
      store.setOverlay({
        kind: "onboarding",
        state: startOnboarding(statuses),
      })
    })
  })

/** scope → login (step 1 → step 2). Statuses are re-read from the `AuthStore`
 *  (the source of truth) every time, so stepping back out of login and into it
 *  again — or arriving from the model step on Esc — always reflects credentials
 *  added so far, instead of the snapshot captured when onboarding opened. */
const transitionToLogin = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    const all = yield* (yield* AuthStore).all
    const statuses = loginStatuses(all)
    yield* Effect.sync(() =>
      store.setOverlay({ kind: "onboarding", state: onboardingToLogin({ ...state, statuses }) }),
    )
  })

export const transitionToMainModel = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    yield* Effect.sync(() => store.toast("fetching models…"))
    const models = yield* registry.list.pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          store.pushBlock({ kind: "error", text: `failed to list ${e.provider} models: ${e.message}` })
          return [] as ReadonlyArray<ModelInfo>
        }),
      ),
    )
    const cur = yield* registry.current
    const currentModelStr = `${cur.provider}:${cur.modelId}`
    yield* Effect.sync(() => {
      store.setOverlay({
        kind: "onboarding",
        state: onboardingToMainModel(state, models, currentModelStr),
      })
    })
  })

const transitionToFastModel = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    yield* Effect.sync(() => store.toast("fetching models…"))
    const models = yield* registry.list.pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          store.pushBlock({ kind: "error", text: `failed to list ${e.provider} models: ${e.message}` })
          return [] as ReadonlyArray<ModelInfo>
        }),
      ),
    )
    const settings = yield* (yield* SettingsStore).get()
    yield* Effect.sync(() => {
      store.setOverlay({
        kind: "onboarding",
        state: onboardingToFastModel(state, models, settings.fastModel),
      })
    })
  })

const transitionToTheme = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    const settings = yield* (yield* SettingsStore).get()
    const currentTheme = settings.theme ?? "efferent"
    yield* Effect.sync(() => {
      store.setOverlay({
        kind: "onboarding",
        state: onboardingToTheme(state, currentTheme),
      })
    })
  })

/** Show the database MANAGER: every configured connection (implicit `local`
 *  first) with the default marked, plus add/done rows. Rebuilt from settings so
 *  it reflects each add / set-default. */
const goManageDatabase = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    const settings = yield* (yield* SettingsStore).get()
    const conns = configuredConns(settings.databases, defaultLocalPath)
    const active = activeConnName(settings.defaultDatabase)
    yield* Effect.sync(() => {
      store.setOverlay({ kind: "onboarding", state: onboardingToDatabase(state, conns, active) })
    })
  })

/** The tier onboarding writes to — the scope chosen in step 1 (stashed on the
 *  run handle), defaulting to global (machine-wide) if somehow unset. */
const onbScope = (store: TuiStore): ConfigScope => store.run.getConfigScope() ?? "global"

/** `e` on a configured connection — re-open the prompt prefilled to edit its
 *  url/path (keeps its name on save). The implicit `local` can't be edited. */
export const editOnboardingDatabase = (
  store: TuiStore,
  state: Extract<OnboardingState, { step: "database" }>,
) =>
  Effect.gen(function* () {
    const item = selectedValue(state.sel)
    if (item === undefined || item.tag !== "use") return
    const conn = item.conn
    if (conn.name === LOCAL_DB_NAME) {
      yield* Effect.sync(() => store.toast("the local database can't be edited"))
      return
    }
    yield* Effect.sync(() =>
      store.setOverlay({ kind: "onboarding", state: databaseEdit(state, conn) }),
    )
  })

/** `d` on a configured connection — forget it (drop from `databases`). If it was
 *  the active default, fall back to the implicit `local` and switch the live store
 *  there so the status bar stays truthful. The implicit `local` can't be removed. */
export const removeOnboardingDatabase = (
  store: TuiStore,
  state: Extract<OnboardingState, { step: "database" }>,
) =>
  Effect.gen(function* () {
    const item = selectedValue(state.sel)
    if (item === undefined || item.tag !== "use") return
    const conn = item.conn
    if (conn.name === LOCAL_DB_NAME) {
      yield* Effect.sync(() => store.toast("the local database can't be removed"))
      return
    }
    const settingsStore = yield* SettingsStore
    const settings = yield* settingsStore.get()
    const wasActive = activeConnName(settings.defaultDatabase) === conn.name
    yield* settingsStore.update((curr) => {
      const databases = { ...(curr.databases ?? {}) }
      delete databases[conn.name]
      if (curr.defaultDatabase === conn.name) {
        const { defaultDatabase: _drop, ...rest } = curr
        return { ...rest, databases }
      }
      return { ...curr, databases }
    }, onbScope(store))
    // If the removed one was live, switch back to local so the active store and
    // the status bar reflect reality.
    if (wasActive) {
      const sw = yield* StoreSwitch
      yield* sw
        .switchTo(LOCAL_DB_NAME, { kind: "sqlite", url: defaultLocalPath }, store.status().cwd)
        .pipe(Effect.catchAll(() => Effect.void))
      yield* Effect.sync(() => store.setStatus({ storage: connLabel(LOCAL_DB_NAME, "sqlite") }))
    }
    yield* Effect.sync(() => store.toast(`removed ${conn.name}`))
    yield* goManageDatabase(store, state)
  })

export const advanceOnboardingStep = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    switch (state.step) {
      case "scope": {
        const scope = selectedValue(state.sel) ?? "global"
        // Stash the choice so EVERY onboarding write (auth via the login flow,
        // and the settings writes below) lands in the same tier.
        yield* Effect.sync(() => store.run.setConfigScope(scope))
        yield* transitionToLogin(store, state)
        break
      }
      case "login":
        break
      case "mainModel": {
        const selected = selectedValue(state.sel)
        if (selected !== undefined) {
          yield* applyModelSelection(store, selected, onbScope(store))
        }
        yield* transitionToFastModel(store, state)
        break
      }
      case "fastModel": {
        const selected = selectedValue(state.sel) // ModelInfo | null
        const settingsStore = yield* SettingsStore
        yield* settingsStore.update((curr) => {
          if (selected === null || selected === undefined) {
            const { fastModel: _drop, ...rest } = curr
            return rest
          }
          return { ...curr, fastModel: `${selected.provider}:${selected.modelId}` }
        }, onbScope(store))
        const nextSettings = yield* settingsStore.get()
        yield* Effect.sync(() => store.setStatus({ roles: rolesChip(nextSettings) }))
        yield* transitionToTheme(store, state)
        break
      }
      case "theme": {
        const selected = selectedValue(state.sel)
        if (selected !== undefined) {
          yield* applyTheme(store, selected, onbScope(store))
        }
        yield* goManageDatabase(store, state)
        break
      }
      case "database": {
        const settingsStore = yield* SettingsStore
        const sw = yield* StoreSwitch
        const cwd = store.status().cwd

        // Add/edit mode: a path (local) / connection string (remote) is being
        // entered. Apply it LIVE — switchTo builds the store + runs pending
        // migrations + swaps it in (no restart). Save only after it connects.
        if (state.connect !== undefined) {
          const adding = state.adding ?? "local"
          const editing = state.editName !== undefined
          const value = promptValue(state.connect).trim()
          if (adding === "remote" && value.length === 0) {
            yield* Effect.sync(() =>
              store.toast("paste a postgres:// connection string, or Esc to go back"),
            )
            break
          }
          const conn =
            adding === "remote"
              ? connFromUrl(value)
              : { kind: "sqlite" as const, url: value.length > 0 ? value : defaultLocalPath }
          // A default-path local connection is the implicit `local` — not stored.
          // Editing always targets a stored, named connection, so never implicit.
          const isImplicitLocal =
            !editing && adding === "local" && (value.length === 0 || value === defaultLocalPath)
          const settings = yield* settingsStore.get()
          const existing = [LOCAL_DB_NAME, ...Object.keys(settings.databases ?? {})]
          // Editing keeps the connection's name; adding auto-names it.
          const name = state.editName ?? (isImplicitLocal ? LOCAL_DB_NAME : suggestName(conn, existing))
          const verb = editing ? "updated" : "added"
          yield* Effect.sync(() => store.setNote("connecting…"))
          const res = yield* sw.switchTo(name, conn, cwd).pipe(Effect.either)
          if (res._tag === "Left") {
            yield* Effect.sync(() => store.setNote(`connection failed: ${res.left.message}`))
            break // stay on the prompt to fix/retry
          }
          yield* settingsStore.update((curr) => {
            const databases = { ...(curr.databases ?? {}) }
            if (!isImplicitLocal) databases[name] = { kind: conn.kind, url: conn.url }
            return { ...curr, databases, defaultDatabase: name }
          }, onbScope(store))
          const n = res.right.conversationCount
          yield* Effect.sync(() => {
            store.setStatus({ storage: connLabel(name, conn.kind) })
            store.setNote(undefined)
            store.toast(
              n > 0
                ? `${verb} ${name} — found ${n} conversation${n === 1 ? "" : "s"}`
                : `${verb} ${name} — database ready`,
            )
          })
          yield* goManageDatabase(store, state)
          break
        }

        // Manager mode: act on the selected row.
        const item = selectedValue(state.sel)
        if (item === undefined || item.tag === "done") {
          yield* Effect.sync(() =>
            store.setOverlay({ kind: "onboarding", state: onboardingToComplete(state) }),
          )
          break
        }
        if (item.tag === "addLocal" || item.tag === "addRemote") {
          const adding = item.tag === "addLocal" ? "local" : "remote"
          yield* Effect.sync(() =>
            store.setOverlay({
              kind: "onboarding",
              state: databaseAdd(state, adding, defaultLocalPath),
            }),
          )
          break
        }
        // use: make this connection the default + switch live.
        const conn = item.conn
        yield* Effect.sync(() => store.setNote("connecting…"))
        const res = yield* sw
          .switchTo(conn.name, { kind: conn.kind, url: conn.url }, cwd)
          .pipe(Effect.either)
        if (res._tag === "Left") {
          yield* Effect.sync(() => store.setNote(`connection failed: ${res.left.message}`))
          break
        }
        yield* settingsStore.update((curr) => ({ ...curr, defaultDatabase: conn.name }), onbScope(store))
        yield* Effect.sync(() => {
          store.setStatus({ storage: connLabel(conn.name, conn.kind) })
          store.setNote(undefined)
        })
        yield* goManageDatabase(store, state)
        break
      }
      case "complete":
        yield* finishOnboarding(store)
        break
    }
  })

export const skipToFastModel = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    yield* transitionToFastModel(store, state)
  })

export const skipToTheme = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    yield* transitionToTheme(store, state)
  })

export const skipToComplete = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      store.setOverlay({
        kind: "onboarding",
        state: onboardingToComplete(state),
      })
    })
  })

/**
 * Step BACK one screen (agy-style Esc = Go Back). Each prior step is rebuilt by
 * its transition (the selects re-fetch from the registry), so back-nav reuses
 * the same builders as forward-nav. From `mainModel` we return to the login
 * picker (a fresh `startOnboarding` at the scope step); the caller handles
 * `login`'s own back/exit semantics.
 */
export const onboardingBack = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    switch (state.step) {
      case "mainModel":
        // Back to the login step (step 2), not the scope picker.
        yield* transitionToLogin(store, state)
        break
      case "fastModel":
        yield* transitionToMainModel(store, state)
        break
      case "theme":
        yield* transitionToFastModel(store, state)
        break
      case "database":
        if (state.connect !== undefined) {
          // From the add prompt, back to the manager list.
          yield* goManageDatabase(store, state)
        } else {
          yield* transitionToTheme(store, state)
        }
        break
      case "complete":
        yield* goManageDatabase(store, state)
        break
      case "scope":
      case "login":
        break
    }
  })

export const finishOnboarding = (store: TuiStore) =>
  Effect.gen(function* () {
    const settingsStore = yield* SettingsStore
    yield* settingsStore.update((curr) => ({ ...curr, onboarded: true }), onbScope(store))
    // Onboarding is over — runtime writes revert to their own defaults
    // (auth → global, settings → local).
    yield* Effect.sync(() => store.run.setConfigScope(undefined))
    yield* Effect.sync(() => {
      store.closeOverlay()
      store.pushBlock({
        kind: "info",
        text: "✓ Onboarding completed! Type to chat, or run :settings to adjust preferences.",
      })
    })
  })
