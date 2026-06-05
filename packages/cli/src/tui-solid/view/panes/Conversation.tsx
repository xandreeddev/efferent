import { pathToFiletype, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, For, onMount, Show } from "solid-js"
import {
  buildConversation,
  buildConversationRows,
  conversationItemId,
  type BodyItem,
  type ScrollbackBlock,
  type ToolBlock,
} from "../../presentation/conversation.js"
import { clampCursor } from "../../presentation/paneNav.js"
import { glyph, tokens } from "../../presentation/theme/index.js"
import { Pane, RailLine } from "../ui/index.js"
import { syntaxStyle, treeSitterClient } from "../syntax.js"
import type { ConvScroller, TuiContext } from "../../state/store.js"

/** Language for a diff's hunk highlighting, parsed from its `+++ <path>` header
 *  (the canonical unified diff core emits). Undefined → no language grammar; the
 *  `<diff>` still renders with `+/-` line colouring, just no per-token colour. */
const diffFiletype = (diff: string): string | undefined => {
  const path = diff.match(/^\+\+\+ (.+)$/m)?.[1]?.trim()
  return path ? pathToFiletype(path) : undefined
}

/**
 * Optional highlight props. `<markdown>`/`<diff>`/`<code>` type `treeSitterClient`
 * and `filetype` as present-or-absent (not `| undefined`) under
 * `exactOptionalPropertyTypes`, so we spread them in only when defined — omitting
 * the key when there's no worker (degrades to un-highlighted) or no language.
 */
const tsProp = (): { treeSitterClient?: never } | { treeSitterClient: NonNullable<ReturnType<typeof treeSitterClient>> } => {
  const ts = treeSitterClient()
  return ts ? { treeSitterClient: ts } : {}
}
const ftProp = (filetype: string | undefined): { filetype?: string } =>
  filetype ? { filetype } : {}

/**
 * Assistant / reasoning prose, rendered as markdown: a leading `●` dot then a
 * native `<markdown>` — headings, bold/italic, lists, inline code and links are
 * styled (see `markdownSyntaxStyle`) instead of showing literal `**`/`#`/`` ` ``.
 * The text arrives complete per turn (we use `generateText`, not `streamText`),
 * so `streaming` stays off.
 *
 * Layout: `<markdown>` advertises a rigid min-content width, so as a flex item in
 * a row it would NOT shrink to the pane and wouldn't wrap (unlike `<text>`, which
 * does). The fix is to let it be a normal block child of a column box — it then
 * stretches to the pane width and wraps — with `paddingLeft={2}` for the hanging
 * indent, and float the `●` over the top-left with `position:absolute` (out of
 * flow, so the markdown still starts at the top). No width math needed.
 */
const Prose = (props: { text: string }) => (
  <box flexDirection="column">
    <text fg={tokens.text.assistant} position="absolute" left={0} top={0}>
      {glyph.railDot}
    </text>
    <markdown
      content={props.text}
      syntaxStyle={syntaxStyle()}
      fg={tokens.text.default}
      paddingLeft={2}
      // Right padding keeps wide content (tables fill the content width) clear of
      // the pane border + the scrollbar column — without it a table's right edge
      // collides with the border (`┐│`).
      paddingRight={2}
      // OpenTUI's default table widthMode is "full" — every table balloons to the
      // pane width (huge empty cells) and overflows/crops when the pane is narrow.
      // "content" sizes tables to their content; "word" wraps cells so a wide
      // table shrinks to fit instead of cropping; cellPaddingX gives the cell text
      // breathing room from the borders (`│ Command │` not `│Command│`).
      tableOptions={{ widthMode: "content", wrapMode: "word", cellPaddingX: 1 }}
      {...tsProp()}
    />
  </box>
)

const ToolPill = (props: { tool: ToolBlock }) => (
  <box flexDirection="column">
    <RailLine dot={tokens.state[props.tool.state]} fg={tokens.text.default} text={props.tool.toolName} />
    <Show when={props.tool.detail}>
      <text fg={tokens.text.muted}>{`  ${glyph.connector} ${props.tool.detail}`}</text>
    </Show>
    {/* edit_file emits a canonical unified diff (--- / +++ / @@) → native <diff>
        gives +/- line colouring; the treeSitterClient + filetype add per-token
        hunk highlighting (JS/TS/markdown/zig; other langs render +/- only). */}
    <Show when={props.tool.diff}>
      {(diff) => (
        <diff
          diff={diff()}
          view="unified"
          syntaxStyle={syntaxStyle()}
          {...tsProp()}
          {...ftProp(diffFiletype(diff()))}
        />
      )}
    </Show>
  </box>
)

/** Render one non-tool block of the rail. */
const Block = (props: { block: ScrollbackBlock }) => {
  const b = props.block
  switch (b.kind) {
    case "assistant":
    case "reasoning":
      return <Prose text={b.text} />
    case "tool":
      return <ToolPill tool={b} />
    case "info":
      return <text fg={tokens.info}>{`  ${b.text}`}</text>
    case "error":
      return (
        <text fg={tokens.error} wrapMode="word">
          {`  ${b.text}`}
        </text>
      )
    case "user":
      return <text fg={tokens.text.user}>{b.text}</text>
    case "checkpoint":
      return <text fg={tokens.text.muted}>{`${glyph.handoff} ${b.text}`}</text>
  }
}

const BodyItemView = (props: { item: BodyItem; collapsed: Set<string> }) => {
  const item = props.item
  if (item.kind === "toolGroup") {
    const folded = () => props.collapsed.has(item.id)
    return (
      <box flexDirection="column">
        <text fg={tokens.text.muted}>
          {`${folded() ? glyph.fold.closed : glyph.fold.open} ${item.tools.length} tool calls`}
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

  // The fold cursor: a flat row list (one per logical unit) the `{}`/`[]` motions
  // move over. `activeKey` is the rendered box id to tint + scroll into view —
  // only while the pane is focused, so an unfocused conversation shows no cursor.
  const rows = createMemo(() => buildConversationRows(items(), store.collapsed()))
  const activeKey = createMemo(() =>
    focused() ? rows()[clampCursor(rows().length, store.convCursor())]?.key : undefined,
  )
  createEffect(() => {
    const k = activeKey()
    if (k !== undefined && sb) sb.scrollChildIntoView(k)
  })
  const cursorBg = (key: string) =>
    activeKey() === key ? { backgroundColor: tokens.cursorLine } : {}

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
    return m === "current" ? tokens.match.current : m === "match" ? tokens.match.other : tokens.match.header
  }

  return (
    <Pane kind="conversation" focused={focused()} title="conversation" grow>
      <scrollbox
        ref={sb}
        stickyScroll={!focused()}
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
                <box id={id} {...cursorBg(id)}>
                  <text fg={tokens.text.muted}>{`${glyph.handoff} ${item.text}`}</text>
                </box>
              )
            }
            if (item.kind === "loose") {
              return (
                <box id={id} flexDirection="column">
                  <For each={item.body}>
                    {(b) => (
                      <box id={b.id} {...cursorBg(b.id)}>
                        <BodyItemView item={b} collapsed={store.collapsed()} />
                      </box>
                    )}
                  </For>
                </box>
              )
            }
            const folded = () => store.collapsed().has(item.id)
            return (
              <box id={id} flexDirection="column" marginTop={1}>
                <box {...cursorBg(item.id)}>
                  <text fg={headerColor(id)}>
                    {folded()
                      ? `${glyph.fold.closed} ${item.subject} · ${item.steps} step${item.steps === 1 ? "" : "s"}`
                      : `${glyph.fold.open} ${item.subject}`}
                  </text>
                </box>
                <Show when={!folded()}>
                  <box flexDirection="column">
                    <For each={item.body}>
                      {(b) => (
                        <box id={b.id} {...cursorBg(b.id)}>
                          <BodyItemView item={b} collapsed={store.collapsed()} />
                        </box>
                      )}
                    </For>
                  </box>
                </Show>
              </box>
            )
          }}
        </For>
      </scrollbox>
    </Pane>
  )
}
