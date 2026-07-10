import { Effect, Option } from "effect"
import { SettingsStore } from "@xandreed/engine"
import type { SettingsKey } from "@xandreed/engine"
import { modelPickerOptions } from "../presentation/modelCatalog.js"
import { openSelect } from "../presentation/selectBox.js"
import type { SmithTuiContext } from "../state/store.js"

/**
 * The `:settings` menu, grown past the model roles onto the P2.1 keys —
 * every row shows its CURRENT value as the tag and Enter edits it through
 * the design system's existing overlays (model picker / toggle / preset
 * picker). No new surfaces.
 *
 * The run knobs (sandbox, maxAttempts, budget) are resolved ONCE at launch
 * (flags > config > defaults), so their notices say "next smith launch";
 * fallbackModel is read by the router per call, so it applies immediately.
 */

export type NumberSettingKey = "maxAttempts" | "budgetMillis"

const appliesNote = (key: SettingsKey): string =>
  key === "fallbackModel" ? "applies to the next model call" : "applies on the next smith launch"

export const openSettingsMenu = (ctx: SmithTuiContext): void => {
  void ctx.run(
    Effect.flatMap(SettingsStore, (store) =>
      Effect.map(store.load, (settings) => {
        const roles = ctx.store.roles()
        ctx.store.setOverlay({
          kind: "select",
          purpose: { tag: "settings" },
          sel: openSelect("settings", [
            { value: Option.some("general"), label: "general model", tag: roles.general },
            { value: Option.some("code"), label: "code model", tag: roles.code },
            { value: Option.some("fast"), label: "fast model", tag: roles.fast },
            {
              value: Option.some("fallbackModel"),
              label: "fallback model",
              tag: Option.getOrElse(settings.fallbackModel, () => "unset"),
              desc: "the router's last rung after retries exhaust",
            },
            {
              value: Option.some("sandbox"),
              label: "sandbox (coder Bash)",
              tag: Option.match(settings.sandbox, {
                onNone: () => "on (default)",
                onSome: (on) => (on ? "on" : "off"),
              }),
              desc: "Enter toggles",
            },
            {
              value: Option.some("maxAttempts"),
              label: "max forge attempts",
              tag: Option.match(settings.maxAttempts, {
                onNone: () => "3 (default)",
                onSome: String,
              }),
            },
            {
              value: Option.some("budgetMillis"),
              label: "forge budget",
              tag: Option.match(settings.budgetMillis, {
                onNone: () => "15m (default)",
                onSome: (ms) => `${Math.round(ms / 60_000)}m`,
              }),
            },
          ]),
        })
      }),
    ),
  )
}

/** Persist one keyed setting (None clears) — close, say so, done. */
export const submitSetting = (
  ctx: SmithTuiContext,
  key: SettingsKey,
  value: Option.Option<string>,
  /** Human form for the notice ("10 minutes" instead of "600000"). */
  shown?: string,
): void => {
  void ctx.run(
    Effect.flatMap(SettingsStore, (store) =>
      store.set(key, value).pipe(
        Effect.map(() => {
          ctx.store.closeOverlay()
          ctx.store.setNotice(
            Option.match(value, {
              onNone: () => `${key} cleared — ${appliesNote(key)}`,
              onSome: (raw) => `${key} = ${shown ?? raw} — ${appliesNote(key)}`,
            }),
          )
        }),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            ctx.store.closeOverlay()
            ctx.store.setNotice(error.message)
          }),
        ),
      ),
    ),
  )
}

/** Enter on the sandbox row FLIPS it and reopens the menu with the fresh tag. */
export const toggleSandbox = (ctx: SmithTuiContext): void => {
  void ctx.run(
    Effect.flatMap(SettingsStore, (store) =>
      store.load.pipe(
        Effect.flatMap((settings) => {
          const next = !Option.getOrElse(settings.sandbox, () => true)
          return store.set("sandbox", Option.some(next ? "true" : "false")).pipe(Effect.as(next))
        }),
        Effect.map((next) => {
          ctx.store.setNotice(`sandbox ${next ? "on" : "off"} — applies on the next smith launch`)
          openSettingsMenu(ctx)
        }),
        Effect.catchAll((error) => Effect.sync(() => ctx.store.setNotice(error.message))),
      ),
    ),
  )
}

const NUMBER_ROWS: Record<
  NumberSettingKey,
  {
    readonly title: string
    readonly presets: ReadonlyArray<{ readonly raw: string; readonly label: string }>
  }
> = {
  maxAttempts: {
    title: "max forge attempts",
    presets: ["1", "2", "3", "5", "10"].map((n) => ({ raw: n, label: `${n} attempts` })),
  },
  budgetMillis: {
    title: "forge budget",
    presets: [5, 10, 15, 30, 60].map((minutes) => ({
      raw: String(minutes * 60_000),
      label: `${minutes} minutes`,
    })),
  },
}

export const openNumberPicker = (ctx: SmithTuiContext, key: NumberSettingKey): void => {
  const rows = NUMBER_ROWS[key]
  ctx.store.setOverlay({
    kind: "select",
    purpose: { tag: "setting-number", key },
    sel: openSelect(rows.title, [
      { value: Option.none<string>(), label: "default", desc: "clear the key" },
      ...rows.presets.map((preset) => ({
        value: Option.some(preset.raw),
        label: preset.label,
      })),
    ]),
  })
}

/** The fallback-model picker: the general catalogue plus an explicit clear
 *  row (there is no smith default to fall back to — unset = no rung). */
export const openFallbackPicker = (ctx: SmithTuiContext): void => {
  void ctx.run(
    Effect.flatMap(SettingsStore, (store) =>
      Effect.map(store.load, (settings) => {
        ctx.store.setOverlay({
          kind: "select",
          purpose: { tag: "fallback-model" },
          sel: openSelect("Select the FALLBACK model", [
            { value: Option.none<string>(), label: "none", desc: "clear the fallback rung" },
            ...modelPickerOptions("general", settings),
          ]),
        })
      }),
    ),
  )
}
