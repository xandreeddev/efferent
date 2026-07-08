import { Effect, Option } from "effect"
import { SettingsStore } from "@xandreed/engine"
import type { ModelRole } from "@xandreed/engine"
import { modelPickerOptions, modelPickerTitle } from "../presentation/modelCatalog.js"
import { openSelect } from "../presentation/selectBox.js"
import type { SmithTuiContext } from "../state/store.js"

/** `:model [role]` — open the curated picker for the role. */
export const openModelPicker = (ctx: SmithTuiContext, role: ModelRole): void => {
  void ctx.run(
    Effect.flatMap(SettingsStore, (store) =>
      Effect.map(store.load, (settings) =>
        ctx.store.setOverlay({
          kind: "select",
          purpose: { tag: "model", role },
          sel: openSelect(modelPickerTitle(role), modelPickerOptions(role, settings)),
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
    Effect.flatMap(SettingsStore, (store) =>
      store.setRole(role, selection).pipe(
        Effect.flatMap(() => store.load),
        Effect.map((settings) => {
          const general = Option.getOrElse(settings.model, () => "(unset)")
          ctx.store.setRoles({
            general,
            code: Option.getOrElse(settings.codeModel, () => general),
            fast: Option.getOrElse(settings.fastModel, () => general),
          })
          ctx.store.closeOverlay()
          ctx.store.setNotice(
            Option.match(selection, {
              onNone: () => `${role} model cleared — applies to the next run`,
              onSome: (s) => `${role} = ${s} — applies to the next run`,
            }),
          )
        }),
      ),
    ),
  )
}
