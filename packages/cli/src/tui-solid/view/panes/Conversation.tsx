import { pathToFiletype, type ScrollBoxRenderable } from "@opentui/core"
import { createMemo, For, onMount, Show } from "solid-js"
import {
  buildConversation,
  buildConversationRows,
  conversationItemId,
  isRenderableDiff,
  toolGroupExpanded,
  toolGroupState,
  toolGroupSummary,
  type BodyItem,
  type ScrollbackBlock,
  type ToolBlock,
} from "../../presentation/conversation.js"
import { clampCursor } from "../../presentation/paneNav.js"
import { formatTokens } from "../../presentation/statusBar.js"
import { glyph, tokens } from "../../state/theme.js"
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
        hunk highlighting (JS/TS/markdown/zig; other langs render +/- only).
        A diff that wouldn't survive the native parser (model-emitted = untrusted)
        renders as a plain dim block instead — degrade to "less pretty", never to
        a parser error painted into the rail. */}
    <Show when={props.tool.diff}>
      {(diff) => (
        <Show
          when={isRenderableDiff(diff())}
          fallback={
            <box paddingLeft={2}>
              <text fg={tokens.text.dim}>{diff()}</text>
            </box>
          }
        >
          <diff
            diff={diff()}
            view="unified"
            syntaxStyle={syntaxStyle()}
            {...tsProp()}
            {...ftProp(diffFiletype(diff()))}
          />
        </Show>
      )}
    </Show>
  </box>
)

/**
 * One fan-out burst's live container: `● Running N agents…` while any row
 * runs, `● Ran N agents` when done — each agent a railed row with its tool
 * count + billed tokens, a running row showing its current tool under a `⎿`.
 */
const AgentsBlock = (props: { block: Extract<ScrollbackBlock, { kind: "agents" }> }) => {
  const agents = () => props.block.agents
  const running = () => agents().filter((a) => a.status === "running").length
  const failed = () => agents().some((a) => a.status === "error")
  const head = () =>
    running() > 0
      ? `Running ${agents().length} agent${agents().length === 1 ? "" : "s"}…`
      : `Ran ${agents().length} agent${agents().length === 1 ? "" : "s"}`
  const headColor = () =>
    running() > 0 ? tokens.state.running : failed() ? tokens.state.error : tokens.state.ok
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={headColor()}>{`${glyph.railDot} `}</text>
        <text fg={tokens.text.muted}>{head()}</text>
      </box>
      <For each={agents()}>
        {(a, i) => (
          <box flexDirection="column">
            <box flexDirection="row">
              <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>
                {`  ${i() === agents().length - 1 ? glyph.tree.corner : glyph.tree.tee} `}
              </text>
              <text fg={tokens.text.default} wrapMode="none" flexShrink={0}>
                {a.name}
              </text>
              <text fg={tokens.text.dim} wrapMode="none">
                {`  · ${a.toolUses} tool use${a.toolUses === 1 ? "" : "s"}${a.tokens > 0 ? ` · ${formatTokens(a.tokens)} tok` : ""}`}
              </text>
            </box>
            <box flexDirection="row">
              <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>
                {`  ${i() === agents().length - 1 ? "  " : glyph.tree.vert} ${glyph.connector}  `}
              </text>
              <text
                fg={
                  a.status === "running"
                    ? tokens.text.dim
                    : a.status === "ok"
                      ? tokens.state.ok
                      : tokens.state.error
                }
                wrapMode="none"
              >
                {a.status === "running"
                  ? (a.currentTool ?? "thinking…")
                  : a.status === "ok"
                    ? "Done"
                    : "Failed"}
              </text>
            </box>
          </box>
        )}
      </For>
    </box>
  )
}

/** Render one non-tool block of the rail. */
const Block = (props: { block: ScrollbackBlock }) => {
  const b = props.block
  switch (b.kind) {
    case "assistant":
    case "reasoning":
      return <Prose text={b.text} />
    case "tool":
      return <ToolPill tool={b} />
    case "agents":
      return <AgentsBlock block={b} />
    case "info":
      // An ephemeral system note (resume/built/quit hints — never persisted).
      // A first-class rail line: ● marker in its own colour. The blank line
      // before it comes from the body-item spacing (every item is marginTop:1),
      // so it isn't glued to the message above.
      return (
        <box flexDirection="row">
          <text fg={tokens.info}>{`${glyph.railDot} ${b.text}`}</text>
        </box>
      )
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

/**
 * A run of ≥2 tool calls, aggregated. Collapsed BY DEFAULT to a one-line summary
 * (`▸ read · grep · edit  (3 tools, +5 -2)`) — the caret coloured by the group's
 * aggregate state so a failure/running call still shows through the fold. Tab/↵
 * (membership in `collapsed` ⇒ expanded, the inverse polarity of a turn) opens it
 * to the individual pills, each spaced by a blank line.
 */
const ToolGroupView = (props: { item: Extract<BodyItem, { kind: "toolGroup" }>; collapsed: Set<string> }) => {
  const item = props.item
  // A group still running shows its live pills (feedback while processing);
  // it settles to the one-line summary when the last call lands.
  const expanded = () => toolGroupExpanded(item.id, item.tools, props.collapsed)
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={tokens.state[toolGroupState(item.tools)]}>
          {`${expanded() ? glyph.fold.open : glyph.fold.closed} `}
        </text>
        <text fg={tokens.text.muted} flexGrow={1} wrapMode="word">
          {toolGroupSummary(item.tools)}
        </text>
      </box>
      <Show when={expanded()}>
        <box flexDirection="column" marginLeft={2}>
          <For each={item.tools}>
            {(t) => (
              <box marginTop={1}>
                <ToolPill tool={t} />
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

const BodyItemView = (props: { item: BodyItem; collapsed: Set<string> }) => {
  const item = props.item
  if (item.kind === "toolGroup") {
    return <ToolGroupView item={item} collapsed={props.collapsed} />
  }
  return <Block block={item.block} />
}

export const Conversation = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  // `viewBlocks` overlays an open node-session preview; writers (the event
  // pump) keep appending to the live `blocks` underneath.
  const items = createMemo(() => buildConversation(store.viewBlocks()))
  const focused = () => store.focus() === "conversation"
  // Solid assigns this during render (before onMount), so the scroller can be
  // registered for the keymap to drive.
  let sb!: ScrollBoxRenderable

  onMount(() => {
    const scroller: ConvScroller = {
      // "absolute" → ± rows; "content" → ±1 whole content (top/bottom, clamped).
      scrollBy: (lines) => sb.scrollBy(lines, "absolute"),
      scrollToTop: () => sb.scrollBy(-1, "content"),
      // Bottom needs a SETTLE, not one call: callers fire right after swapping
      // the whole block list, but OpenTUI lays the new content out on a later
      // frame — a single scroll lands at the OLD bottom, which the new layout
      // reads as a manual mid-scroll and permanently disengages sticky-bottom
      // (the rail stops following). Landing exactly at the true bottom is what
      // re-engages it, so re-scroll across a couple of layout frames.
      scrollToBottom: () => {
        sb.scrollBy(1, "content")
        setTimeout(() => sb.scrollBy(1, "content"), 40)
        setTimeout(() => sb.scrollBy(1, "content"), 120)
      },
      scrollIntoView: (id) => sb.scrollChildIntoView(id),
      viewportRows: () => sb.viewport?.height ?? 20,
    }
    store.convScroller.current = scroller
  })

  // The fold cursor: a flat row list (one per logical unit) the `{}`/`[]` motions
  // move over. `activeKey` is the rendered box id to *tint* — only while the pane
  // is focused, so an unfocused conversation shows no cursor. Scroll-into-view is
  // driven imperatively by the motion keys (`keys/dispatch`), NOT reactively here:
  // a reactive effect would also fire on streamed content and yank the view back
  // to a stale cursor, leaving the freshly-appended bottom unscrolled. Sticky-
  // bottom (below) owns "follow new content"; the cursor owns "jump on keypress".
  const rows = createMemo(() => buildConversationRows(items(), store.collapsed()))
  const activeKey = createMemo(() =>
    focused() ? rows()[clampCursor(rows().length, store.convCursor())]?.key : undefined,
  )
  // One background per row, ALWAYS set (never a removed prop): the cursor wins,
  // else the current search match, else an explicit transparent. Returning `{}`
  // for inactive rows (a removed `backgroundColor`) didn't repaint — old tints
  // lingered as the cursor moved, so every visited row stayed highlighted.
  const rowBg = (key: string): string =>
    activeKey() === key
      ? tokens.cursorLine
      : matchOf(key) === "current"
        ? tokens.cursorLine
        : tokens.bgNone

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
    return m === "current" ? tokens.match.current : m === "match" ? tokens.match.other : tokens.text.user
  }

  return (
    <Pane
      kind="conversation"
      focused={focused()}
      title={store.nodePreview()?.title ?? "conversation"}
      grow
    >
      <scrollbox
        ref={sb}
        stickyScroll
        stickyStart="bottom"
        scrollY
        flexGrow={1}
        flexDirection="column"
        verticalScrollbarOptions={{ visible: false }}
      >
        {/* A blank line top + bottom so the first/last message (incl. the
            "resumed" / "press Ctrl-C again" info lines) isn't glued to the
            pane border or the sticky-bottom scroll edge. */}
        <text flexShrink={0}> </text>
        <For each={items()}>
          {(item, i) => {
            const id = conversationItemId(item, i())
            if (item.kind === "checkpoint") {
              return (
                <box id={id} marginTop={1} backgroundColor={rowBg(id)}>
                  <text fg={tokens.text.muted}>{`${glyph.handoff} ${item.text}`}</text>
                </box>
              )
            }
            if (item.kind === "loose") {
              return (
                <box id={id} flexDirection="column">
                  <For each={item.body}>
                    {(b) => (
                      <box id={b.id} marginTop={1} backgroundColor={rowBg(b.id)}>
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
                {/* The turn head IS the user's message, styled like a typed
                    prompt (`❯ …`, quiet gray) — Claude-style, not a chrome-heavy
                    bar+caret banner. The blank-line rhythm + the distinct glyph
                    keep it scannable; fold state shows as a trailing `▸ N steps`
                    only when collapsed, so the common (expanded) case is clean. */}
                <box flexDirection="row" backgroundColor={rowBg(item.id)}>
                  <text fg={tokens.text.dim} flexShrink={0}>{`${glyph.msg.user} `}</text>
                  <text fg={headerColor(id)} wrapMode="word" flexShrink={1}>
                    {item.subject}
                  </text>
                  <Show when={folded()}>
                    <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>
                      {`  ${glyph.fold.closed} ${item.steps} step${item.steps === 1 ? "" : "s"}`}
                    </text>
                  </Show>
                </box>
                <Show when={!folded()}>
                  <box flexDirection="column">
                    <For each={item.body}>
                      {(b) => (
                        <box id={b.id} marginTop={1} backgroundColor={rowBg(b.id)}>
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
        <text flexShrink={0}> </text>
      </scrollbox>
    </Pane>
  )
}
