import { html, raw, render } from "../html.js"
import {
  ID_APP,
  ID_CANVAS,
  ID_CHAT,
  ID_CHAT_DRAWER,
  ID_COMPOSER,
  ID_RAIL,
  ID_REFS_DRAWER,
  ID_RESYNC_FORM,
  ID_STAGE,
  ID_STAGE_EMPTY,
  ID_WS_ITEMS,
} from "../ids.js"
import { assetHref } from "../assets/static.js"
import { pagesContents, railContents, resolveActivePage, workspaceContents } from "../fragments/regions.js"
import { renderActivity } from "../components/activity.js"
import { renderApproval } from "../components/approval.js"
import { renderHeader } from "../components/header.js"
import { renderPlan } from "../components/plan.js"
import { renderQueue } from "../components/queue.js"
import { renderReply } from "../components/reply.js"
import { renderTabs } from "../components/tabs.js"
import type { ShellView } from "../views.js"

/** The empty-stage hero: invites the platform's use cases. `data-suggest`
 *  buttons prefill the composer (app.js). Hidden by CSS once a page exists. */
const stageEmpty = html`<div id="${ID_STAGE_EMPTY}" class="ef-stage-empty">
  <div class="ef-stage-empty-mark">▌efferent</div>
  <p class="ef-stage-empty-lede">Ask for anything — the agent builds it as a live page.</p>
  <div class="ef-stage-empty-hints">
    <button type="button" class="ef-btn" data-suggest="Show me the architecture of this project with some visuals.">explain this codebase visually</button>
    <button type="button" class="ef-btn" data-suggest="Compare the top 3 options for ">compare options for…</button>
    <button type="button" class="ef-btn" data-suggest="Here is my data — break it down with a table and a chart: ">break down my data</button>
    <button type="button" class="ef-btn" data-suggest="Teach me about  — build a lesson page with an exercise.">teach me something</button>
  </div>
</div>`

/**
 * The full HTML document — canvas-first: the stage (tabs + full-bleed pages +
 * empty hero) is the primary surface; the transcript and references live in
 * overlay drawers; the dock (approval · queue · reply bubble · activity strip
 * · command bar) floats bottom-center. Growing-region/singleton markup is
 * shared with `renderFullSync` (fragments/regions.ts) so the initial page and
 * a reconnect snapshot can never drift; drawer shells, the stage wrapper, the
 * hero, and the dock exist ONLY here (static — client-side open/closed state
 * survives resyncs). The `#ef-app` wrapper owns the WS connection and stamps
 * `data-mermaid-src` for the lazy diagram renderer.
 */
export const renderShell = (view: ShellView): string => {
  const active = resolveActivePage(view.canvas, view.activePage)
  const doc = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>efferent — ${view.header.sessionTitle}</title>
<link rel="icon" href="data:," />
<link rel="stylesheet" href="${assetHref("tokens.css")}" />
<link rel="stylesheet" href="${assetHref("app.css")}" />
<link rel="stylesheet" href="${assetHref("kit.css")}" />
<script>${raw(`try{var t=localStorage.getItem("ef-theme");if(t)document.documentElement.setAttribute("data-theme",t)}catch(e){}`)}</script>
<script src="${assetHref("htmx.min.js")}"></script>
<script src="${assetHref("htmx-ext-ws.js")}"></script>
<script src="${assetHref("app.js")}" defer></script>
<script src="${assetHref("diagrams.js")}" defer></script>
</head>
<body>
<div id="${ID_APP}" class="ef-shell" hx-ext="ws" ws-connect="${view.wsUrl}" data-mermaid-src="${assetHref("mermaid.min.js")}">
  ${renderHeader(view.header)}
  <main id="${ID_STAGE}" class="ef-stage">
    ${renderTabs(view.canvas, active)}
    <div id="${ID_CANVAS}" class="ef-pages">${pagesContents(view.canvas, active)}</div>
    ${stageEmpty}
  </main>
  <aside id="${ID_CHAT_DRAWER}" class="ef-drawer ef-drawer--left" aria-label="transcript">
    <div class="ef-drawer-head">
      <span class="ef-drawer-title">transcript</span>
      <button type="button" class="ef-drawer-close" data-drawer-toggle="chat" title="close">✕</button>
    </div>
    ${renderPlan(view.plan)}
    <section id="${ID_CHAT}" class="ef-chat">
      <ol id="${ID_RAIL}" class="ef-rail">${railContents(view.blocks)}</ol>
    </section>
  </aside>
  <aside id="${ID_REFS_DRAWER}" class="ef-drawer ef-drawer--right" aria-label="references">
    <div class="ef-drawer-head">
      <span class="ef-drawer-title">references</span>
      <button type="button" class="ef-drawer-close" data-drawer-toggle="refs" title="close">✕</button>
    </div>
    <div id="${ID_WS_ITEMS}" class="ef-stack">${workspaceContents(view.workspace)}</div>
  </aside>
  <div class="ef-dock">
    ${renderApproval(view.approval)}
    ${renderQueue(view.queue)}
    ${renderReply(view.reply)}
    ${renderActivity(view.activity)}
    <form id="${ID_COMPOSER}" class="ef-cmdbar" ws-send>
      <input type="hidden" name="page" value="${active ?? ""}" />
      <textarea name="prompt" class="ef-cmdbar-input" placeholder="ask for a page, a change, an answer… (Enter to send)" rows="1"></textarea>
      <button class="ef-btn ef-btn--primary" type="submit">send</button>
    </form>
  </div>
  <form id="${ID_RESYNC_FORM}" ws-send hx-trigger="ef:resync from:body" hidden>
    <input type="hidden" name="type" value="resync" />
  </form>
</div>
</body>
</html>`
  return render(doc)
}
