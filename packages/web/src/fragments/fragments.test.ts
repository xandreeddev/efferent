import { describe, expect, test } from "bun:test"
import { appendChatBlock, upsertChatBlock } from "./blocks.js"
import {
  appendPageItem,
  appendRegionItem,
  appendWorkspaceItem,
  removeRegionItem,
  upsertPageItem,
  upsertPlan,
  upsertRegionItem,
  upsertWorkspaceItem,
} from "./workspace.js"
import { renderFullSync } from "./sync.js"
import { upsertActivity, upsertApproval, upsertHeader, upsertQueue, upsertReply, upsertTabs } from "./singletons.js"
import { MAIN_REGION, type CanvasItemView, type ChatBlockView, type ShellView } from "../views.js"

const msg: ChatBlockView = { kind: "message", key: "m:p3:a0", role: "assistant", markdown: "**hi**" }
const pill: ChatBlockView = { kind: "tool", id: "0:read_file:1", label: "read_file(src/x.ts)", state: "running" }

/** A whole-page CanvasItemView (a single `_main` component). */
const page = (id: string, html: string, title?: string): CanvasItemView => ({
  id,
  ...(title !== undefined ? { title } : {}),
  regions: [{ region: MAIN_REGION, html }],
})

const shell: ShellView = {
  header: { sessionTitle: "s", workspace: "/w", model: "kimi", status: "idle", agentsRunning: 0 },
  blocks: [msg, pill],
  workspace: [{ kind: "file", file: { path: "a.ts", content: "x", startLine: 1 } }],
  plan: { steps: [{ text: "one", status: "active" }] },
  canvas: [page("quiz", "<p>q</p>"), page("arch", "<h1>arch</h1>", "Architecture")],
  activity: { status: "idle", agentsRunning: 0 },
  queue: { items: ["next"] },
  wsUrl: "/ws?t=x",
}

describe("fragments", () => {
  test("append WRAPS the block (htmx selector-OOB inserts children, not the node)", () => {
    const out = appendChatBlock(msg)
    // The throwaway wrapper carries the oob attribute…
    expect(out).toMatch(/^<div hx-swap-oob="beforeend:#ef-rail">/)
    // …and the keyed component root is a CHILD, so its id survives the insert.
    expect(out).toContain(`<li id="blk-m_3Ap3_3Aa0"`)
    expect(out).toContain("<strong>hi</strong>")
  })

  test("upsert uses hx-swap-oob=true ON the root with the SAME id as append (idempotent key)", () => {
    const a = appendChatBlock(pill)
    const b = upsertChatBlock({ ...pill, state: "ok", detail: "12 lines" })
    const idOf = (s: string): string => /id="(blk-[^"]+)"/.exec(s)?.[1] ?? ""
    expect(idOf(a)).toBe(idOf(b))
    expect(b).toMatch(/^<li id="blk-[^"]+" class="ef-pill[^"]*" hx-swap-oob="true">/)
    expect(b).toContain("ef-pill--ok")
  })

  test("a pill with a workspace card carries data-ref (click-to-open the refs drawer)", () => {
    const out = upsertChatBlock({ ...pill, state: "ok", refId: "ws-file-src_2Fx_2Ets" })
    expect(out).toContain(`data-ref="ws-file-src_2Fx_2Ets"`)
    expect(out).toContain("ef-pill--linked")
  })

  test("workspace file cards key by path; plan routes to its singleton slot", () => {
    const file = appendWorkspaceItem({ kind: "file", file: { path: "src/a.ts", content: "x", startLine: 1 } })
    expect(file).toMatch(/^<div hx-swap-oob="beforeend:#ef-ws-items">/)
    expect(file).toContain(`id="ws-file-src_2Fa_2Ets"`)
    const plan = appendWorkspaceItem({ kind: "plan", plan: { steps: [] } })
    expect(plan).toContain(`id="ef-plan"`)
    expect(plan).toContain(`hx-swap-oob="true"`)
    expect(upsertPlan({ steps: [{ text: "a", status: "done" }] })).toContain("ef-plan-item--done")
    const upd = upsertWorkspaceItem({ kind: "file", file: { path: "src/a.ts", content: "y", startLine: 1 } })
    expect(upd).toContain(`hx-swap-oob="true"`)
  })

  test("pages sanitize agent html, key by agent-chosen id, render full-bleed (no card chrome)", () => {
    const out = appendPageItem(page("ex-1", `<script>x</script><p>safe</p>`, "Quiz"), true)
    expect(out).toMatch(/^<div hx-swap-oob="beforeend:#ef-canvas">/)
    expect(out).toContain(`id="ui-ex-1"`)
    expect(out).toContain("ef-page--active")
    expect(out).toContain(`data-page-id="ex-1"`)
    expect(out).toContain(`id="uib-ex-1"`) // the keyed page body (regions append here)
    expect(out).not.toContain("<script>")
    expect(out).toContain("<p>safe</p>")
    expect(out).not.toContain("ef-wcard") // pages are full-bleed, not cards
    expect(out).toContain("sanitized: 1 removed")
    // An update keeps the same id; a background update is not active.
    const upd = upsertPageItem(page("ex-1", "<p>v2</p>"), false)
    expect(upd).toContain(`id="ui-ex-1"`)
    expect(upd).toContain(`hx-swap-oob="true"`)
    expect(upd).not.toContain("ef-page--active")
  })

  test("component fragments address ONE region: append into the page body, upsert/delete the region node", () => {
    // A new component wraps in a beforeend-into-the-page-body OOB…
    const add = appendRegionItem("home", { region: "hero", html: "<h1>hi</h1>" })
    expect(add).toMatch(/^<div hx-swap-oob="beforeend:#uib-home">/)
    expect(add).toContain(`id="uir-home_00hero"`) // keyed by (page, region); NUL → _00
    expect(add).toContain(`data-region="hero"`)
    expect(add).toContain("<h1>hi</h1>")
    // …an update outerHTML-replaces ONLY that region node (siblings untouched)…
    const upd = upsertRegionItem("home", { region: "hero", html: "<h1>welcome</h1>" })
    expect(upd).toMatch(/^<div id="uir-home_00hero" class="ef-region" data-region="hero" hx-swap-oob="true">/)
    expect(upd).toContain("<h1>welcome</h1>")
    // …and a remove is an OOB delete of just that node.
    const del = removeRegionItem("home", "hero")
    expect(del).toContain(`id="uir-home_00hero"`)
    expect(del).toContain(`hx-swap-oob="delete"`)
  })

  test("the tab bar upserts alongside pages: one tab per page, active marked, empty collapses", () => {
    const tabs = upsertTabs(shell.canvas, "arch")
    expect(tabs).toContain(`id="ef-tabs"`)
    expect(tabs).toContain(`hx-swap-oob="true"`)
    expect(tabs).toContain(`data-page="ui-quiz"`)
    expect(tabs).toContain(`data-page-id="arch"`)
    expect(tabs).toContain("Architecture") // title is the tab label…
    expect(tabs).toContain(">quiz</button>") // …falling back to the id
    expect(/class="ef-tab ef-tab--active"[^>]*data-page-id="arch"/.test(tabs)).toBe(true)
    expect(upsertTabs([], undefined)).toContain("ef-tabs--empty")
  })

  test("full sync rebuilds every region in one message (incl. tabs/activity/reply; drawer shells NEVER)", () => {
    const out = renderFullSync(shell)
    expect(out).toContain(`<ol id="ef-rail" hx-swap-oob="innerHTML">`)
    expect(out).toContain(`<div id="ef-ws-items" hx-swap-oob="innerHTML">`)
    expect(out).toContain(`<div id="ef-canvas" hx-swap-oob="innerHTML">`)
    expect(out).toContain(`id="ef-header"`)
    expect(out).toContain(`id="ef-tabs"`)
    expect(out).toContain(`id="ef-plan"`)
    expect(out).toContain(`id="ef-activity"`)
    expect(out).toContain(`id="ef-reply"`)
    expect(out).toContain(`id="ef-queue"`)
    expect(out).toContain(`id="ef-approval"`)
    // Static shells are shell-only (client drawer/tab state survives a resync).
    expect(out).not.toContain(`id="ef-chat-drawer"`)
    expect(out).not.toContain(`id="ef-refs-drawer"`)
    expect(out).not.toContain(`id="ef-stage-empty"`)
    // The plan singleton must NOT be duplicated inside the workspace stack.
    expect(out.split(`id="ef-plan"`).length).toBe(2)
    // With no explicit activePage the LAST page is focused.
    expect(/id="ui-arch" class="ef-page ef-page--active"/.test(out)).toBe(true)
    expect(/id="ui-quiz" class="ef-page ef-page--active"/.test(out)).toBe(false)
  })

  test("singleton upserts always replace by fixed id", () => {
    expect(upsertHeader(shell.header)).toContain(`id="ef-header" class="ef-header" hx-swap-oob="true"`)
    expect(upsertQueue({ items: [] })).toContain("ef-queue--empty")
    expect(upsertApproval(undefined)).toContain("ef-approval--empty")
    const sheet = upsertApproval({ tool: "Bash", summary: "rm -rf /tmp/x", cwd: "/w", ruleKey: "bash:rm" })
    expect(sheet).toContain("approval needed")
    expect(sheet).toContain(`hx-post="/action/approve"`)
    // Each button carries its OWN decision via hx-vals — no reliance on htmx
    // including a submit button's value (the "accept button doesn't work" fix).
    expect(sheet).toContain(`hx-vals='{"decision":"once"}'`)
    expect(sheet).toContain(`hx-vals='{"decision":"deny"}'`)
    expect(sheet).toContain(`hx-include="#ef-approval-reason"`)
    // type="button" so a stray native form submit can't fire.
    expect((sheet.match(/type="button"/g) ?? []).length).toBe(4)
  })

  test("activity: idle hides; busy carries the label, started-at stamp, and the interrupt form", () => {
    expect(upsertActivity({ status: "idle", agentsRunning: 0 })).toContain("ef-activity--idle")
    const busy = upsertActivity({ status: "tool", label: "Read(src/x.ts)", startedAt: 1234, agentsRunning: 2 })
    expect(busy).toContain(`data-started-at="1234"`)
    expect(busy).toContain("Read(src/x.ts)")
    expect(busy).toContain("◆ 2")
    expect(busy).toContain(`hx-post="/action/interrupt"`)
  })

  test("reply bubble: undefined clears; a reply carries its identity key + markdown", () => {
    expect(upsertReply(undefined)).toContain("ef-reply--empty")
    const out = upsertReply({ key: "m:p7:a0", markdown: "**done** — see the page" })
    expect(out).toContain(`data-key="m:p7:a0"`)
    expect(out).toContain("<strong>done</strong>")
    expect(out).toContain("ef-reply-dismiss")
    expect(out).toContain(`data-drawer-toggle="chat"`)
  })
})
