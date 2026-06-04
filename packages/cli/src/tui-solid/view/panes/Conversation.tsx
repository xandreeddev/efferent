import type { ScrollBoxRenderable } from "@opentui/core"
import { createMemo, For, onMount, Show } from "solid-js"
import {
  buildConversation,
  conversationItemId,
  type BodyItem,
  type ScrollbackBlock,
  type ToolBlock,
} from "../../model/conversation.js"
import { paneBorder, theme } from "../../theme.js"
import type { ConvScroller, TuiContext } from "../../state/store.js"

/**
 * One event-rail line: a coloured `●` dot followed by content text. OpenTUI
 * `<span>` carries no colour, so per-segment colour is two `<text>`s in a row;
 * the content text grows + wraps so prose flows within the pane width.
 */
const Rail = (props: { dot: string; fg: string; text: string; wrap?: boolean }) => (
  <box flexDirection="row">
    <text fg={props.dot}>● </text>
    <text fg={props.fg} flexGrow={1} wrapMode={props.wrap ? "word" : "none"}>
      {props.text}
    </text>
  </box>
)

const ToolPill = (props: { tool: ToolBlock }) => (
  <box flexDirection="column">
    <Rail dot={theme.tool[props.tool.state]} fg={theme.text} text={props.tool.toolName} />
    <Show when={props.tool.detail}>
      <text fg={theme.gray}>{`  ⎿ ${props.tool.detail}`}</text>
    </Show>
    <Show when={props.tool.diff}>
      <text fg={theme.gray} wrapMode="none">
        {props.tool.diff}
      </text>
    </Show>
  </box>
)

/** Render one non-tool block of the rail. */
const Block = (props: { block: ScrollbackBlock }) => {
  const b = props.block
  switch (b.kind) {
    case "assistant":
    case "reasoning":
      return <Rail dot={theme.assistant} fg={theme.text} text={b.text} wrap />
    case "tool":
      return <ToolPill tool={b} />
    case "info":
      return <text fg={theme.info}>{`  ${b.text}`}</text>
    case "error":
      return (
        <text fg={theme.error} wrapMode="word">
          {`  ${b.text}`}
        </text>
      )
    case "user":
      return <text fg={theme.user}>{b.text}</text>
    case "checkpoint":
      return <text fg={theme.gray}>{`⚑ ${b.text}`}</text>
  }
}

const BodyItemView = (props: { item: BodyItem; collapsed: Set<string> }) => {
  const item = props.item
  if (item.kind === "toolGroup") {
    const folded = () => props.collapsed.has(item.id)
    return (
      <box flexDirection="column">
        <text fg={theme.gray}>
          {`${folded() ? "▸" : "▾"} ${item.tools.length} tool calls`}
        </text>
        <Show when={!folded()}>
          <For each={item.tools}>{(t) => <ToolPill tool={t} />}</For>
        </Show>
      </box>
    )
  }
  return <Block block={item.block} />
}

export const Conversation = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const items = createMemo(() => buildConversation(store.blocks()))
  const focused = () => store.focus() === "conversation"
  // Solid assigns this during render (before onMount), so the scroller can be
  // registered for the keymap to drive.
  let sb!: ScrollBoxRenderable

  onMount(() => {
    const scroller: ConvScroller = {
      // "absolute" → ± rows; "content" → ±1 whole content (top/bottom, clamped).
      scrollBy: (lines) => sb.scrollBy(lines, "absolute"),
      scrollToTop: () => sb.scrollBy(-1, "content"),
      scrollToBottom: () => sb.scrollBy(1, "content"),
      scrollIntoView: (id) => sb.scrollChildIntoView(id),
      viewportRows: () => sb.viewport?.height ?? 20,
    }
    store.convScroller.current = scroller
  })

  // Which search bucket a top-level item id falls in — drives match highlight.
  const matchOf = (id: string): "current" | "match" | "none" => {
    const s = store.search()
    if (s === undefined) return "none"
    const at = s.matchIds.indexOf(id)
    if (at === -1) return "none"
    return at === s.index ? "current" : "match"
  }
  const headerColor = (id: string): string => {
    const m = matchOf(id)
    return m === "current" ? theme.select : m === "match" ? theme.accent.conversation : theme.turnHeader
  }

  return (
    <box
      border
      title=" conversation "
      borderColor={paneBorder("conversation", focused())}
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      flexDirection="column"
    >
      <scrollbox
        ref={sb}
        stickyScroll
        stickyStart="bottom"
        scrollY
        flexGrow={1}
        flexDirection="column"
      >
        <For each={items()}>
          {(item, i) => {
            const id = conversationItemId(item, i())
            if (item.kind === "checkpoint") {
              return (
                <box id={id}>
                  <text fg={theme.gray}>{`⚑ ${item.text}`}</text>
                </box>
              )
            }
            if (item.kind === "loose") {
              return (
                <box id={id} flexDirection="column">
                  <For each={item.body}>
                    {(b) => <BodyItemView item={b} collapsed={store.collapsed()} />}
                  </For>
                </box>
              )
            }
            const folded = () => store.collapsed().has(item.id)
            return (
              <box id={id} flexDirection="column" marginTop={1}>
                <text fg={headerColor(id)}>
                  {folded()
                    ? `▸ ${item.subject} · ${item.steps} step${item.steps === 1 ? "" : "s"}`
                    : `▾ ${item.subject}`}
                </text>
                <Show when={!folded()}>
                  <box flexDirection="column">
                    <For each={item.body}>
                      {(b) => <BodyItemView item={b} collapsed={store.collapsed()} />}
                    </For>
                  </box>
                </Show>
              </box>
            )
          }}
        </For>
      </scrollbox>
    </box>
  )
}
