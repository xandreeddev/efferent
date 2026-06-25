import { pathToFiletype, type ScrollBoxRenderable } from "@opentui/core"
import { createMemo, For, onMount, Show } from "solid-js"
import {
  buildConversation,
  buildConversationRows,
  conversationItemId,
  isRenderableDiff,
  reconcileItems,
  splitByMatch,
  toolGroupExpanded,
  toolGroupState,
  toolGroupSummary,
  type BodyItem,
  type ConversationItem,
  type ScrollbackBlock,
  type ToolBlock,
} from "../../presentation/conversation.js"
import { clampCursor } from "../../presentation/paneNav.js"
import { glyph, tokens } from "../../state/theme.js"
import { HlText, Pane, RailLine, type Hl } from "../ui/index.js"
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
const Prose = (props: { text: string; hl?: Hl | undefined }) => {
  // Word chips can't be spliced into the native <markdown> renderable, so
  // while a search is active AND this prose contains the query, render it as
  // chip-capable plain text instead — raw markdown markers may show, which is
  // the right trade while hunting for text; Esc (clearing the search) restores
  // the styled markdown. Prose without an occurrence keeps markdown rendering.
  const searchMatched = createMemo(
    () => props.hl !== undefined && splitByMatch(props.text, props.hl.query).some((s) => s.match),
  )
  return (
    <box flexDirection="column">
      <text fg={tokens.text.assistant} position="absolute" left={0} top={0}>
        {glyph.railDot}
      </text>
      <Show
        when={searchMatched()}
        fallback={
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
        }
      >
        <box paddingLeft={2} paddingRight={2}>
          <HlText text={props.text} fg={tokens.text.default} hl={props.hl} />
        </box>
      </Show>
    </box>
  )
}

/** Tool output (bash stdout, grep, search answer, ls/glob) shown expanded
 *  beneath the pill — capped to keep the always-expanded rail usable; the full
 *  output is one re-read / narrower query away (the model can recover it).
 *  read_file carries no output (its body is for the model, not the rail), so it
 *  never reaches here — the pill's `N lines` detail is all the human sees. */
const OUTPUT_PREVIEW_LINES = 20
const OutputPreview = (props: { text: string; hl?: Hl | undefined }) => {
  const lines = () => props.text.replace(/\s+$/, "").split("\n")
  const shown = () => lines().slice(0, OUTPUT_PREVIEW_LINES)
  const more = () => Math.max(0, lines().length - OUTPUT_PREVIEW_LINES)
  return (
    <box flexDirection="column" paddingLeft={2}>
      <For each={shown()}>
        {(l) => <HlText text={l.length > 0 ? l : " "} fg={tokens.text.dim} hl={props.hl} />}
      </For>
      <Show when={more() > 0}>
        <text fg={tokens.text.muted}>{`… ${more()} more line${more() === 1 ? "" : "s"}`}</text>
      </Show>
    </box>
  )
}

const ToolPill = (props: { tool: ToolBlock; hl?: Hl | undefined }) => (
  <box flexDirection="column">
    <RailLine
      dot={tokens.state[props.tool.state]}
      fg={tokens.text.default}
      text={props.tool.toolName}
      hl={props.hl}
    />
    <Show when={props.tool.detail}>
      {(detail) => (
        <box flexDirection="row">
          <text fg={tokens.text.muted} flexShrink={0}>{`  ${glyph.connector} `}</text>
          <HlText text={detail()} fg={tokens.text.muted} hl={props.hl} />
        </box>
      )}
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
    {/* Output (read content / bash stdout / grep / search answer / ls / glob) —
        shown expanded beneath the pill, capped. A diff-bearing tool (edit/write)
        carries no `output`, so the two Shows never both fire. */}
    <Show when={props.tool.output}>
      {(output) => <OutputPreview text={output()} hl={props.hl} />}
    </Show>
  </box>
)

/** Render one non-tool block of the rail. Plain-text kinds route through
 *  {@link HlText} so an active search highlights matched words; markdown prose
 *  can't splice spans, so it keeps the row tint only. */
const Block = (props: { block: ScrollbackBlock; hl?: Hl | undefined }) => {
  const b = props.block
  switch (b.kind) {
    case "assistant":
    case "reasoning":
      return <Prose text={b.text} hl={props.hl} />
    case "tool":
      return <ToolPill tool={b} hl={props.hl} />
    case "agents":
      // The fleet lives ONLY in the right-pane fleet tree now — never on the
      // conversation rail (it was redundant + the reorder-churn source). The
      // kind stays in the union for the cache/projection; the rail renders nothing.
      return null
    case "info":
      // An ephemeral system note (resume/built/quit hints — never persisted).
      // A first-class rail line: ● marker in its own colour. The blank line
      // before it comes from the body-item spacing (every item is marginTop:1),
      // so it isn't glued to the message above.
      return (
        <box flexDirection="row">
          <text fg={tokens.info} flexShrink={0}>{`${glyph.railDot} `}</text>
          <HlText text={b.text} fg={tokens.info} hl={props.hl} />
        </box>
      )
    case "error":
      // A failed turn must be LOUD on the rail (it used to be a quiet indented
      // line that read as silence): a red ● marker + the message in the error
      // colour, with the blank-line rhythm every block gets.
      return (
        <box flexDirection="row">
          <text fg={tokens.error} flexShrink={0}>{`${glyph.railDot} `}</text>
          <HlText text={b.text} fg={tokens.error} hl={props.hl} />
        </box>
      )
    case "user":
      return <HlText text={b.text} fg={tokens.text.user} hl={props.hl} />
    case "checkpoint":
      return (
        <box flexDirection="row">
          <text fg={tokens.text.muted} flexShrink={0}>{`${glyph.handoff} `}</text>
          <HlText text={b.text} fg={tokens.text.muted} hl={props.hl} />
        </box>
      )
  }
}

/**
 * A run of ≥2 tool calls, aggregated. Collapsed BY DEFAULT to a one-line summary
 * (`▸ read · grep · edit  (3 tools, +5 -2)`) — the caret coloured by the group's
 * aggregate state so a failure/running call still shows through the fold. Tab/↵
 * (membership in `collapsed` ⇒ expanded, the inverse polarity of a turn) opens it
 * to the individual pills, each spaced by a blank line.
 */
const ToolGroupView = (props: {
  item: Extract<BodyItem, { kind: "toolGroup" }>
  collapsed: Set<string>
  hl?: Hl | undefined
}) => {
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
        <HlText text={toolGroupSummary(item.tools)} fg={tokens.text.muted} hl={props.hl} grow />
      </box>
      <Show when={expanded()}>
        <box flexDirection="column" marginLeft={2}>
          <For each={item.tools}>
            {(t) => (
              <box marginTop={1}>
                <ToolPill tool={t} hl={props.hl} />
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

export const BodyItemView = (props: { item: BodyItem; collapsed: Set<string>; hl?: Hl | undefined }) => {
  const item = props.item
  if (item.kind === "toolGroup") {
    return <ToolGroupView item={item} collapsed={props.collapsed} hl={props.hl} />
  }
  return <Block block={item.block} hl={props.hl} />
}

export const Conversation = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  // `viewBlocks` overlays an open node-session preview; writers (the event
  // pump) keep appending to the live `blocks` underneath. Reconcile each fresh
  // build against the previous one so unchanged rows keep their object identity
  // — the reference-keyed `<For>` then reuses them instead of re-rendering the
  // whole markdown/diff/tree-sitter rail on every streamed event (the slow caret).
  const items = createMemo<ConversationItem[]>(
    (prev) => reconcileItems(prev, buildConversation(store.viewBlocks())),
    [],
  )
  const focused = () => store.focus() === "chat"
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
  // One background per row, ALWAYS set (never a removed prop): the current
  // match wins (brightest), then any other match, then the fold cursor, else an
  // explicit transparent. Returning `{}` for inactive rows (a removed
  // `backgroundColor`) didn't repaint — old tints lingered as the cursor moved,
  // so every visited row stayed highlighted.
  const rowBg = (key: string): string => {
    const m = matchOf(key)
    if (m === "current") return tokens.match.currentLine
    if (m === "match") return tokens.match.line
    return activeKey() === key ? tokens.cursorLine : tokens.bgNone
  }

  // Which search bucket a rendered row id falls in — drives match highlight.
  // Match ids ARE row ids (turn heads, body items, checkpoints), so body rows
  // get their own tint via `rowBg`.
  const matchOf = (id: string): "current" | "match" | "none" => {
    const s = store.search()
    if (s === undefined) return "none"
    const at = s.matchIds.indexOf(id)
    if (at === -1) return "none"
    return at === s.index ? "current" : "match"
  }
  // Turns whose BODY holds a match — a folded one tints its header so a hit
  // hidden behind the fold is still signposted (n/N will unfold it on arrival).
  const matchTurns = createMemo((): ReadonlySet<string> => {
    const hits = store.search()?.hits
    if (hits === undefined) return new Set<string>()
    return new Set(hits.flatMap((h) => (h.turnId !== undefined ? [h.turnId] : [])))
  })
  const headerColor = (id: string, folded: boolean): string => {
    const m = matchOf(id)
    if (m === "current") return tokens.match.current
    if (m === "match") return tokens.match.other
    if (folded && matchTurns().has(id)) return tokens.match.other
    return tokens.text.user
  }
  // The word-level highlight input for a row: the active conversation query
  // (hlsearch — chips wherever it occurs, snapshot or not) + whether this row
  // is the current [i/N] match (brighter chip).
  const hlOf = (id: string): Hl | undefined => {
    const s = store.search()
    if (s === undefined || s.pane !== "conversation" || s.query.trim().length === 0) return undefined
    return { query: s.query, current: s.matchIds[s.index] === id }
  }

  return (
    <Pane grow>
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
                <box id={id} marginTop={1} backgroundColor={rowBg(id)} flexDirection="row">
                  <text fg={tokens.text.muted} flexShrink={0}>{`${glyph.handoff} `}</text>
                  <HlText text={item.text} fg={tokens.text.muted} hl={hlOf(id)} />
                </box>
              )
            }
            if (item.kind === "loose") {
              return (
                <box id={id} flexDirection="column">
                  <For each={item.body}>
                    {(b) => (
                      <box id={b.id} marginTop={1} backgroundColor={rowBg(b.id)}>
                        <BodyItemView item={b} collapsed={store.collapsed()} hl={hlOf(b.id)} />
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
                  {/* Expanded → the message verbatim; folded → first line only.
                      The head owns the user text in both states, so it shows
                      exactly once (no truncated-subject + full-copy dup). */}
                  <HlText
                    text={folded() ? item.subject : item.text}
                    fg={headerColor(id, folded())}
                    hl={hlOf(id)}
                  />
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
                          <BodyItemView item={b} collapsed={store.collapsed()} hl={hlOf(b.id)} />
                        </box>
                      )}
                    </For>
                  </box>
                </Show>
              </box>
            )
          }}
        </For>
        {/* The "is it working?" cue lives in the bottom-chrome running loader
            now (agy-style, directly above the input — see `RunningLoader`), not
            buried at the bottom of the scrollback where it could scroll out of
            view. Tool pills still own their own in-rail spinners. */}
        <text flexShrink={0}> </text>
      </scrollbox>
    </Pane>
  )
}
