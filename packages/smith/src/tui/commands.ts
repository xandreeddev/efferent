import { Effect, Match } from "effect"
import { SettingsStore } from "@xandreed/sdk-core"
import type { Settings } from "@xandreed/sdk-core"
import type { SmithTuiContext } from "./state/store.js"

const coerce = (value: string): string | number | boolean =>
  value === "true" ? true : value === "false" ? false : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value

const ROLE_KEYS: Record<string, "model" | "codeModel" | "fastModel"> = {
  general: "model",
  code: "codeModel",
  fast: "fastModel",
}

const persist = (ctx: SmithTuiContext, patch: Record<string, unknown>, note: string): void => {
  void ctx.run(
    Effect.flatMap(SettingsStore, (store) =>
      store.update((current) => ({ ...current, ...patch }) as Settings),
    ).pipe(
      Effect.tap(() => Effect.sync(() => ctx.store.setNotice(note))),
      Effect.catchAllCause((cause) =>
        Effect.sync(() => ctx.store.setNotice(`failed: ${String(cause)}`)),
      ),
    ),
  )
}

/**
 * The `:` commands — the efferent CLI's configuration conventions, minimal:
 *   :quit / :q                end the TUI (exit code = the finished run's, else 130)
 *   :lock                     refine mode: approve + lock the current draft
 *   :forge                    refine mode: forge the locked spec (in this TUI)
 *   :model <p:m>              persist the GENERAL role to .efferent/config.json
 *   :model code|fast <p:m>    persist that role
 *   :set <key> <value>        persist any Settings key (coerced bool/number)
 * Models are pinned at run start, so a switch applies to the NEXT run.
 */
export const runTuiCommand = (ctx: SmithTuiContext, raw: string): void => {
  const words = raw.replace(/^:/, "").trim().split(/\s+/)
  const command = words[0] ?? ""
  Match.value(command).pipe(
    Match.whenOr("quit", "q", () => {
      ctx.exit(ctx.store.exitCode() ?? 130)
    }),
    Match.when("lock", () => {
      if (ctx.lock === undefined) {
        ctx.store.setNotice(":lock only applies in refine mode")
        return
      }
      ctx.lock()
    }),
    Match.when("forge", () => {
      if (ctx.forge === undefined) {
        ctx.store.setNotice(":forge only applies in refine mode")
        return
      }
      ctx.forge()
    }),
    Match.when("model", () => {
      const roleKey = ROLE_KEYS[words[1] ?? ""]
      const selection = roleKey === undefined ? words[1] : words[2]
      const key = roleKey ?? "model"
      if (selection === undefined || selection.length === 0) {
        ctx.store.setNotice("usage: :model [code|fast] <provider:modelId>")
        return
      }
      persist(ctx, { [key]: selection }, `${key} = ${selection} — applies to the next run`)
    }),
    Match.when("set", () => {
      const key = words[1]
      const value = words.slice(2).join(" ")
      if (key === undefined || value.length === 0) {
        ctx.store.setNotice("usage: :set <key> <value>")
        return
      }
      persist(ctx, { [key]: coerce(value) }, `${key} = ${value}`)
    }),
    Match.orElse(() => {
      ctx.store.setNotice(`unknown command: :${command} (try :quit · :model · :set)`)
    }),
  )
}
