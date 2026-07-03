import { html, join, type Html } from "../html.js"
import { domIdForKey } from "../ids.js"
import type { AgentChipView, ChatBlockView } from "../views.js"
import { oobAttr } from "./oob.js"

type AgentsBlockView = Extract<ChatBlockView, { kind: "agents" }>

const formatTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)

const renderChip = (a: AgentChipView): Html => html`<div class="ef-agent-chip ef-agent-chip--${a.status}">
  <span class="ef-agent-dot">${a.status === "running" ? "●" : a.status === "ok" ? "✓" : "✗"}</span>
  <span class="ef-agent-name">${a.name}</span>
  <span class="ef-agent-meta">${a.toolUses} tools · ${formatTokens(a.tokens)} tok${a.currentTool !== undefined ? html` · ${a.currentTool}` : ""}</span>
  ${a.summary !== undefined && html`<div class="ef-agent-summary">${a.summary}</div>`}
</div>`

/** The sub-agent fan-out block: one chip per running/finished agent. */
export const renderAgentsBlock = (view: AgentsBlockView, oob?: string): Html => {
  const id = domIdForKey("blk", view.id)
  const running = view.agents.filter((a) => a.status === "running").length
  const label = running > 0 ? `running ${running} agent${running === 1 ? "" : "s"}` : "agents"
  return html`<li id="${id}" class="ef-agents"${oobAttr(oob)}>
    <div class="ef-agents-head">${label}</div>
    ${join(view.agents.map(renderChip))}
  </li>`
}
