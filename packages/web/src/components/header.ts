import { html, type Html } from "../html.js"
import { ID_CONN, ID_HEADER, ID_REFS_COUNT } from "../ids.js"
import type { HeaderView } from "../views.js"
import { oobAttr } from "./oob.js"

/**
 * The slim header: wordmark · session title · drawer toggles (transcript /
 * references) · model · theme picker · conn badge. Run status lives in the
 * activity strip (the dock), not here; the refs count badge is painted
 * client-side from the drawer's card count (app.js, conn-badge discipline).
 */
export const renderHeader = (view: HeaderView, oob?: string): Html =>
  html`<header id="${ID_HEADER}" class="ef-header"${oobAttr(oob)}>
    <span class="ef-wordmark">▌efferent</span>
    <span class="ef-header-title">${view.sessionTitle}</span>
    <span class="ef-header-right">
      ${view.agentsRunning > 0 && html`<span class="ef-header-agents">◆ ${view.agentsRunning} agent${view.agentsRunning === 1 ? "" : "s"}</span>`}
      <button type="button" class="ef-header-btn" data-drawer-toggle="refs" title="references (files · diffs · sources)">⧉ refs<span id="${ID_REFS_COUNT}" class="ef-count-badge"></span></button>
      <button type="button" class="ef-header-btn" data-drawer-toggle="chat" title="transcript">💬 chat<span class="ef-unread-dot" hidden></span></button>
      <span class="ef-header-model">${view.model}</span>
      <span class="ef-muted" title="${view.workspace}">${view.workspace}</span>
      <select class="ef-theme-pick" aria-label="theme">
        <option value="efferent">efferent</option>
        <option value="one-dark">one-dark</option>
        <option value="tokyo-night">tokyo-night</option>
      </select>
      <span id="${ID_CONN}" class="ef-conn ef-conn--closed" title="connection">○</span>
    </span>
  </header>`
