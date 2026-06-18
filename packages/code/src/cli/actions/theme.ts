import { Effect } from "effect"
import { type ConfigScope, SettingsStore } from "@xandreed/sdk-core"
import { openSelect, type SelectOption } from "../presentation/selectBox.js"
import { activeThemeName, setTheme, themeNames } from "../state/theme.js"
import type { TuiStore } from "../state/store.js"

/**
 * Switch the active TUI colour theme and persist it. `setTheme` flips the global
 * theme signal (every view painting with a token re-renders next frame, and
 * `syntaxStyle()` rebuilds for the new theme); the choice is written to
 * `config.json` via `SettingsStore.update` so it survives a restart (seeded back
 * at boot in `runtime.ts`). An unknown name is a no-op with a rail hint.
 */
export const applyTheme = (store: TuiStore, name: string, scope?: ConfigScope) =>
  Effect.gen(function* () {
    if (!setTheme(name)) {
      store.pushBlock({
        kind: "error",
        text: `unknown theme '${name}' — run :theme to pick (${themeNames().join(", ")})`,
      })
      return
    }
    yield* (yield* SettingsStore).update((s) => ({ ...s, theme: name }), scope)
    store.toast(`theme: ${name}`)
  })

/**
 * Open the theme picker overlay — the registered themes as a select list, the
 * active one pre-highlighted. Mirrors `openModelPicker`; Enter routes through
 * `submitSelect`'s `theme` branch to {@link applyTheme}.
 */
export const openThemePicker = (store: TuiStore) =>
  Effect.sync(() => {
    const cur = activeThemeName()
    const options: ReadonlyArray<SelectOption<string>> = themeNames().map((name) => ({
      value: name,
      label: name,
      active: name === cur,
    }))
    store.setOverlay({
      kind: "select",
      sel: openSelect("Select a theme", options),
      purpose: { tag: "theme" },
    })
  })
