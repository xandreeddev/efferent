import { For, Match, Switch } from "solid-js"
import { glyph, tokens } from "../../../state/theme.js"
import type { TuiContext } from "../../../state/store.js"
import { Activity } from "./Activity.js"
import { ContextView } from "./Context.js"
import { ContextTreeView } from "./ContextTree.js"
import { NodeDetail } from "./NodeDetail.js"
import { SessionsView } from "./Sessions.js"

const VIEWS = [
  { id: "stack", label: "activity" },
  { id: "context", label: "context" },
  { id: "tree", label: "agents" },
  { id: "sessions", label: "sessions" },
] as const

/**
 * The contextual **panel** (agy direction): borderless, fills the message
 * region when a side view is focused (`:activity` / `:context` / `:tree` /
 * `:sessions`, or `v` to cycle). A leading tab row shows where you are; the
 * **agents** view splits — the navigator tree on TOP holds the cursor, and a
 * live **detail section** BELOW mirrors whatever the cursor is on (summary /
 * files / seed for a node, its live tool feed while running, session identity
 * for a conversation). No box, no border — the conversation lives in the same
 * region and this rises over it on demand.
 */
export const Side = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const view = () => store.sidePane().view

  // A rule-style head (`── agents ──`) — the corner glyph read as a tree row.
  const sectionHead = (label: string) => (
    <text fg={tokens.accent.side} flexShrink={0}>
      {`${glyph.seedRule} ${label} ${glyph.seedRule}`}
    </text>
  )

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0}>
      {/* The view switcher: the active tab leads with a pointer in the side
          accent; a blank line below separates the chrome from the content. */}
      <box flexDirection="row" flexShrink={0} marginBottom={1}>
        <For each={VIEWS}>
          {(v, i) => (
            <>
              <text fg={view() === v.id ? tokens.accent.side : tokens.text.dim}>
                {view() === v.id ? `${glyph.pointer} ${v.label}` : v.label}
              </text>
              {i() < VIEWS.length - 1 && <text fg={tokens.text.dim}>{"  ·  "}</text>}
            </>
          )}
        </For>
      </box>
      <Switch fallback={<Activity ctx={props.ctx} />}>
        <Match when={view() === "context"}>
          <ContextView ctx={props.ctx} />
        </Match>
        <Match when={view() === "tree"}>
          {/* Tree on top (holds the cursor); the detail mirrors the cursor
              BELOW it, content-sized (capped at half) — a three-line detail
              must not cost fifty percent of the region. */}
          <box flexDirection="column" flexGrow={1} flexBasis={0} overflow="hidden">
            {sectionHead("agents")}
            <ContextTreeView ctx={props.ctx} />
          </box>
          <box flexDirection="column" flexShrink={0} maxHeight="50%" overflow="hidden" marginTop={1}>
            {sectionHead("selected")}
            <NodeDetail ctx={props.ctx} />
          </box>
        </Match>
        <Match when={view() === "sessions"}>
          <SessionsView ctx={props.ctx} />
        </Match>
      </Switch>
    </box>
  )
}
