import { Effect, Match } from "effect"
import { SettingsStore } from "@xandreed/engine"
import type { SmithTuiContext } from "./state/store.js"

/**
 * The `:` commands — minimal on the new line:
 *   :quit / :q     end the TUI (exit code = the finished run's, else 130)
 *   :lock          refine mode: approve + lock the current draft
 *   :forge         refine mode: forge the locked spec (in this TUI)
 *   :model <p:m>   persist the GENERAL model to .efferent/config.json
 * Models are pinned at run start, so a switch applies to the NEXT run.
 * Role models (code/fast) and arbitrary keys are edited in
 * `.efferent/config.json` directly — the engine's settings surface is
 * deliberately small.
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
      const selection = words[1]
      if (selection === undefined || selection.length === 0 || !selection.includes(":")) {
        ctx.store.setNotice("usage: :model <provider:modelId>")
        return
      }
      void ctx.run(
        Effect.flatMap(SettingsStore, (store) => store.setModel(selection)).pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              ctx.store.setNotice(`model = ${selection} — applies to the next run`),
            ),
          ),
          Effect.catchAllCause((cause) =>
            Effect.sync(() => ctx.store.setNotice(`failed: ${String(cause)}`)),
          ),
        ),
      )
    }),
    Match.orElse(() => {
      ctx.store.setNotice(
        `unknown command: :${command} (try :quit · :model — other keys: edit .efferent/config.json)`,
      )
    }),
  )
}
