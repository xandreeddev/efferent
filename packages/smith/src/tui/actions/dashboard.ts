import { Match, Option } from "effect"
import {
  dashboardRows,
  findRow,
  rowActions,
  rowOption,
  rowTitle,
} from "../presentation/dashboard.js"
import type { DashboardRow } from "../presentation/dashboard.js"
import { openSelect } from "../presentation/selectBox.js"
import type { SmithTuiContext } from "../state/store.js"

/**
 * The dashboard's drivers: `:open` lists every row in the ONE select overlay,
 * ⏎ on a row (focused or picked) opens its action menu, ⏎ on an action runs
 * the runtime capability behind it. Deleting asks first — it is the only
 * verb here that cannot be undone.
 */

export const openDashboardMenu = (ctx: SmithTuiContext): void => {
  const rows = dashboardRows(ctx.store.workspace(), ctx.store.context())
  if (rows.length === 0) {
    ctx.store.setNotice("nothing to open yet — describe what to build")
    return
  }
  ctx.store.setDashboardFocus(Option.none())
  ctx.store.setOverlay({
    kind: "select",
    purpose: { tag: "dashboard" },
    sel: openSelect("Open — specs · forge runs · sessions · lessons", rows.map(rowOption)),
  })
}

export const openRowActions = (ctx: SmithTuiContext, row: DashboardRow): void => {
  ctx.store.setDashboardFocus(Option.none())
  ctx.store.setOverlay({
    kind: "select",
    purpose: { tag: "row-actions", row },
    sel: openSelect(rowTitle(row), rowActions(row)),
  })
}

/** The row under the dashboard cursor, if any. */
export const focusedRow = (ctx: SmithTuiContext): Option.Option<DashboardRow> =>
  Option.flatMap(ctx.store.dashboardFocus(), (index) =>
    Option.fromNullishOr(dashboardRows(ctx.store.workspace(), ctx.store.context())[index]),
  )

/** ⏎ on the `:open` list — that row's actions. */
export const submitDashboardPick = (ctx: SmithTuiContext, value: Option.Option<string>): void => {
  ctx.store.closeOverlay()
  Option.match(
    Option.flatMap(value, (key) => findRow(dashboardRows(ctx.store.workspace(), ctx.store.context()), key)),
    {
      onNone: () => ctx.store.setNotice("nothing selected"),
      onSome: (row) => openRowActions(ctx, row),
    },
  )
}

const openDeleteConfirm = (ctx: SmithTuiContext, slug: string): void => {
  ctx.store.setOverlay({
    kind: "select",
    purpose: { tag: "confirm-delete-spec", slug },
    sel: openSelect(`delete spec ${slug}?`, [
      { value: Option.some("keep"), label: "keep it", active: true },
      {
        value: Option.some("delete"),
        label: `delete ${slug}`,
        desc: `removes .efferent/specs/${slug}.md — not undoable`,
      },
    ]),
  })
}

/** ⏎ on an action row — the capability behind the verb. */
export const submitRowAction = (
  ctx: SmithTuiContext,
  row: DashboardRow,
  value: Option.Option<string>,
): void => {
  ctx.store.closeOverlay()
  const dashboard = ctx.dashboard
  if (dashboard === undefined) {
    ctx.store.setNotice("the dashboard only acts in the workspace session")
    return
  }
  const verb = Option.getOrElse(value, () => "")
  Match.value(row).pipe(
    Match.when({ kind: "spec" }, (spec) => {
      if (verb === "open") return dashboard.openSpec(spec.slug)
      if (verb === "lock") return dashboard.lockSpec(spec.slug)
      if (verb === "forge") return ctx.forge?.(spec.slug)
      if (verb === "delete") return openDeleteConfirm(ctx, spec.slug)
      return ctx.store.setNotice(`no such action: ${verb}`)
    }),
    Match.when({ kind: "run" }, (run) => {
      if (verb === "report") return dashboard.showRun(run.id)
      if (verb === "follow-up") return dashboard.followUpRun(run.id)
      return ctx.store.setNotice(`no such action: ${verb}`)
    }),
    Match.when({ kind: "session" }, (session) => {
      if (verb === "resume") return ctx.resume?.(session.id)
      return ctx.store.setNotice(`no such action: ${verb}`)
    }),
    Match.when({ kind: "context-standing" }, (source) => {
      if (verb === "toggle") return ctx.context?.toggle(source.name)
      return ctx.store.setNotice(`no such action: ${verb}`)
    }),
    Match.when({ kind: "context-pin" }, (pin) => {
      if (verb === "toggle") return ctx.context?.setPin(String(pin.index + 1), !pin.on)
      if (verb === "remove") return ctx.context?.drop(String(pin.index + 1))
      return ctx.store.setNotice(`no such action: ${verb}`)
    }),
    Match.when({ kind: "lesson" }, (lesson) => ctx.store.setNotice(lesson.text)),
    Match.exhaustive,
  )
}

/** ⏎ on the delete confirmation. */
export const submitDeleteConfirm = (
  ctx: SmithTuiContext,
  slug: string,
  value: Option.Option<string>,
): void => {
  ctx.store.closeOverlay()
  if (Option.getOrElse(value, () => "keep") !== "delete") {
    ctx.store.setNotice(`kept ${slug}`)
    return
  }
  Option.match(Option.fromNullishOr(ctx.dashboard), {
    onNone: () => ctx.store.setNotice("the dashboard only acts in the workspace session"),
    onSome: (dashboard) => dashboard.deleteSpec(slug),
  })
}
