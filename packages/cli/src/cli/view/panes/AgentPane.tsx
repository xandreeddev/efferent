import { createMemo, For, Show } from "solid-js"
import {
  buildConversation,
  reconcileItems,
  type ConversationItem,
} from "../../presentation/conversation.js"
import { glyph, tokens } from "../../state/theme.js"
import { BodyItemView } from "./Conversation.js"
import type { TuiContext } from "../../state/store.js"

/** Tool groups render settled (one line) here — this is a read-only watch pane,
 *  not the curation surface, so there's no fold cursor to expand them. */
const EMPTY = new Set<string>()

/**
 * The RIGHT pane: the selected agent's live session, shown beside the
 * orchestrator (the left pane) so you watch a teammate work without losing the
 * lead. Read-only and **sticky-following** — its OpenTUI `stickyScroll` tracks
 * the agent's streaming narration/tools (the event pump appends to
 * `nodePreview().blocks` while this node is the open preview). You steer it from
 * the composer: typing while it's open routes to this agent's mailbox
 * (`submitToNode`). Esc closes it back to the orchestrator.
 */
export const AgentPane = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const preview = () => store.nodePreview()
  const title = () => preview()?.title ?? "agent"
  // The agent's live log (accumulated by the event pump, seeded from persistence
  // on open) — so swapping to it shows its full state, and a running one streams.
  const items = createMemo<ConversationItem[]>((prev) => {
    const id = preview()?.nodeId
    return reconcileItems(prev, buildConversation(id !== undefined ? [...store.nodeLog(id)] : []))
  }, [])
  // Live = this node is in the running fleet (the header tracks it the same way).
  const running = () => {
    const id = preview()?.nodeId
    return id !== undefined && store.agentState().fleet.some((m) => m.nodeId === id)
  }

  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
      {/* Title: a spinner + "working" while the agent runs, else a quiet dot. */}
      <box flexDirection="row" flexShrink={0} marginBottom={1}>
        <text fg={running() ? tokens.state.running : tokens.accent.side} flexShrink={0}>
          {`${running() ? glyph.spinner[store.spinner() % glyph.spinner.length] : glyph.railDot} `}
        </text>
        <text fg={tokens.accent.side} wrapMode="none" flexShrink={1}>
          {title()}
        </text>
        <Show when={running()}>
          <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>
            {"  · working"}
          </text>
        </Show>
      </box>
      <scrollbox
        stickyScroll
        stickyStart="bottom"
        scrollY
        flexGrow={1}
        flexDirection="column"
        verticalScrollbarOptions={{ visible: false }}
      >
        <text flexShrink={0}> </text>
        <Show
          when={items().length > 0}
          fallback={
            <text fg={tokens.text.dim}>
              {running() ? "waiting for the agent…" : "no activity yet"}
            </text>
          }
        >
          <For each={items()}>
            {(item) => {
              if (item.kind === "checkpoint") {
                return (
                  <box flexDirection="row" marginTop={1}>
                    <text fg={tokens.text.muted} flexShrink={0}>{`${glyph.handoff} `}</text>
                    <text fg={tokens.text.muted}>{item.text}</text>
                  </box>
                )
              }
              if (item.kind === "loose") {
                return (
                  <box flexDirection="column">
                    <For each={item.body}>
                      {(b) => (
                        <box marginTop={1}>
                          <BodyItemView item={b} collapsed={EMPTY} />
                        </box>
                      )}
                    </For>
                  </box>
                )
              }
              // A turn: the agent's inbound line (its task / a message to it),
              // then its work under it.
              return (
                <box flexDirection="column" marginTop={1}>
                  <box flexDirection="row">
                    <text fg={tokens.text.dim} flexShrink={0}>{`${glyph.msg.user} `}</text>
                    <text fg={tokens.text.user} wrapMode="word">
                      {item.text}
                    </text>
                  </box>
                  <For each={item.body}>
                    {(b) => (
                      <box marginTop={1}>
                        <BodyItemView item={b} collapsed={EMPTY} />
                      </box>
                    )}
                  </For>
                </box>
              )
            }}
          </For>
        </Show>
        <text flexShrink={0}> </text>
      </scrollbox>
    </box>
  )
}
