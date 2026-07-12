import { Effect, Option } from "effect"
import { ModelCatalog, SettingsStore } from "@xandreed/engine"
import type { ModelRole } from "@xandreed/engine"
import { reasoningEffortsFor } from "@xandreed/providers"
import type { ReasoningEffort } from "@xandreed/providers"
import { modelPickerOptions, modelPickerTitle } from "../presentation/modelCatalog.js"
import { openSelect } from "../presentation/selectBox.js"
import type { SmithTuiContext } from "../state/store.js"

const effortKey = (role: ModelRole) =>
  role === "general"
    ? "reasoningEffort" as const
    : role === "code"
      ? "codeReasoningEffort" as const
      : "fastReasoningEffort" as const

const currentEffort = (role: ModelRole, settings: {
  readonly reasoningEffort: Option.Option<ReasoningEffort>
  readonly codeReasoningEffort: Option.Option<ReasoningEffort>
  readonly fastReasoningEffort: Option.Option<ReasoningEffort>
}) => role === "general"
  ? settings.reasoningEffort
  : role === "code"
    ? settings.codeReasoningEffort
    : settings.fastReasoningEffort

/** `:model [role]` — open the curated picker for the role. */
export const openModelPicker = (ctx: SmithTuiContext, role: ModelRole): void => {
  void ctx.run(
    Effect.all({ settings: Effect.flatMap(SettingsStore, (store) => store.load), catalog: Effect.flatMap(ModelCatalog, (catalog) => catalog.list) }).pipe(
      Effect.map(({ settings, catalog }) =>
        ctx.store.setOverlay({
          kind: "select",
          purpose: { tag: "model", role },
          sel: openSelect(modelPickerTitle(role), modelPickerOptions(role, settings, catalog)),
        }),
      ),
    ),
  )
}

/** Persist a picker choice (None clears the role) and refresh the readout. */
export const submitModel = (
  ctx: SmithTuiContext,
  role: ModelRole,
  selection: Option.Option<string>,
): void => {
  void ctx.run(
    Effect.flatMap(SettingsStore, (store) => {
      const efforts = Option.match(selection, {
        onNone: () => [] as ReadonlyArray<ReasoningEffort>,
        onSome: reasoningEffortsFor,
      })
      return store.setRole(role, selection).pipe(
        Effect.flatMap(() =>
          efforts.length === 0
            ? store.set(effortKey(role), Option.none()).pipe(Effect.zipRight(store.load))
            : store.load,
        ),
        Effect.map((settings) => {
          const general = Option.getOrElse(settings.model, () => "(unset)")
          ctx.store.setRoles({
            general,
            code: Option.getOrElse(settings.codeModel, () => general),
            fast: Option.getOrElse(settings.fastModel, () => general),
          })
          if (Option.isSome(selection) && efforts.length > 0) {
            const active = currentEffort(role, settings)
            ctx.store.setOverlay({
              kind: "select",
              purpose: { tag: "model-effort", role, selection: selection.value },
              sel: openSelect(
                `Select reasoning effort for ${selection.value}`,
                efforts.map((effort) => ({
                  value: Option.some<string>(effort),
                  label: effort,
                  active: Option.contains(active, effort),
                })),
              ),
            })
          } else {
            ctx.store.closeOverlay()
          }
          ctx.store.setNotice(
            Option.match(selection, {
              onNone: () => `${role} model cleared — applies to the next run`,
              onSome: (s) => efforts.length > 0
                ? `${role} = ${s} — now choose its reasoning effort`
                : `${role} = ${s} — applies to the next run`,
            }),
          )
        }),
      )
    }),
  )
}

/** Persist the model-dependent second step. */
export const submitModelEffort = (
  ctx: SmithTuiContext,
  role: ModelRole,
  selection: string,
  value: Option.Option<string>,
): void => {
  void ctx.run(
    Effect.flatMap(SettingsStore, (store) =>
      store.set(effortKey(role), value).pipe(
        Effect.tap(() => store.load),
        Effect.map(() => {
          ctx.store.closeOverlay()
          ctx.store.setNotice(
            Option.match(value, {
              onNone: () => `${role} = ${selection}; reasoning effort cleared`,
              onSome: (effort) => `${role} = ${selection}; reasoning effort = ${effort}`,
            }),
          )
        }),
      ),
    ),
  )
}
