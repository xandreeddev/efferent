import { Match, Option } from "effect"
import { quitCode } from "./keys.js"
import { resolveCommand } from "./presentation/palette.js"
import { openSelect } from "./presentation/selectBox.js"
import { logout, openLoginFlow } from "./actions/login.js"
import { openModelPicker, submitModel } from "./actions/model.js"
import type { SmithTuiContext } from "./state/store.js"

/**
 * The `:` commands — only ones that WORK:
 *   :quit / :q            end the TUI (exit code = the finished run's, else 130)
 *   :new                  drop the current draft, back to the dashboard
 *   :lock                 approve + lock the current draft
 *   :forge [slug]         forge the locked draft, or a named locked spec
 *   :model [code|fast] [p:m]   picker for the role (or set directly)
 *   :login / :logout [p]  provider manager / remove a credential
 * Models are pinned at run start, so a switch applies to the NEXT run.
 */
export const runTuiCommand = (ctx: SmithTuiContext, raw: string): void => {
  const words = raw.replace(/^:/, "").trim().split(/\s+/)
  const typed = words[0] ?? ""
  // Unique-prefix resolution — what the palette shows is what Enter runs.
  const command = Option.getOrElse(resolveCommand(typed), () => typed)
  Match.value(command).pipe(
    Match.whenOr("quit", "q", () => {
      ctx.exit(quitCode(ctx.store.exitCode()))
    }),
    Match.when("new", () => {
      if (ctx.newSpec === undefined) {
        ctx.store.setNotice(":new only applies in the workspace session")
        return
      }
      ctx.newSpec()
    }),
    Match.when("lock", () => {
      if (ctx.lock === undefined) {
        ctx.store.setNotice(":lock needs a refine session")
        return
      }
      ctx.lock()
    }),
    Match.when("forge", () => {
      if (ctx.forge === undefined) {
        ctx.store.setNotice(":forge needs a refine/workspace session")
        return
      }
      const slug = words[1]
      if (slug !== undefined && slug.length > 0) {
        ctx.forge(slug)
        return
      }
      ctx.forge()
    }),
    Match.when("model", () => {
      const first = words[1] ?? ""
      const role = first === "code" || first === "fast" ? first : "general"
      const selection = first === "code" || first === "fast" ? (words[2] ?? "") : first
      if (selection.includes(":")) {
        submitModel(ctx, role, Option.some(selection))
        return
      }
      if (selection.length > 0) {
        ctx.store.setNotice("usage: :model [code|fast] [provider:modelId]")
        return
      }
      openModelPicker(ctx, role)
    }),
    Match.when("resume", () => {
      if (ctx.resume === undefined) {
        ctx.store.setNotice(":resume only applies in the workspace session")
        return
      }
      const id = words[1]
      if (id !== undefined && id.length > 0) {
        ctx.resume(id)
        return
      }
      const sessions = ctx.store.workspace().sessions
      if (sessions.length === 0) {
        ctx.store.setNotice("no previous sessions in this workspace")
        return
      }
      ctx.store.setOverlay({
        kind: "select",
        purpose: { tag: "resume" },
        sel: openSelect(
          "Resume a session",
          sessions.map((s) => ({
            value: Option.some(s.id),
            label: s.label,
            tag: s.ageMinutes < 60 ? `${s.ageMinutes}m ago` : `${Math.round(s.ageMinutes / 60)}h ago`,
          })),
        ),
      })
    }),
    Match.when("login", () => {
      openLoginFlow(ctx)
    }),
    Match.when("logout", () => {
      const provider = words[1]
      logout(ctx, provider !== undefined && provider.length > 0 ? Option.some(provider) : Option.none())
    }),
    Match.orElse(() => {
      ctx.store.setNotice(
        `unknown command: :${typed} (:quit · :new · :lock · :forge [slug] · :model [code|fast] · :resume · :login · :logout)`,
      )
    }),
  )
}
