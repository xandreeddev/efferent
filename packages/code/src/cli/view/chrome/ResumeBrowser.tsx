import { createMemo, For, Show } from "solid-js"
import type { ConvSummary } from "@xandreed/sdk-core"
import type { Overlay as OverlayState, TuiContext } from "../../state/store.js"
import { activeTab, filteredConvs, type ResumeState } from "../../presentation/resumeBrowser.js"
import { glyph, tokens } from "../../state/theme.js"
import { Cursor, KeyHints, truncate } from "../ui/index.js"

const ROWS = 8

/** "9h ago" / "3d ago" — agy's right-aligned conversation age. */
const relativeAge = (ts: number): string => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const convLabel = (c: ConvSummary): string =>
  (c.title ?? c.firstPrompt ?? "(untitled)").replace(/\s+/g, " ").trim() || "(untitled)"

/**
 * The agy **tabbed resume browser** (`:resume` / `:browse`), borderless + inline
 * in the bottom chrome: a connection tab strip (`local (sqlite)   pg   (tab to
 * cycle)`), a `/`-search line, the active tab's conversations (title left, age
 * right) windowed with `↑/↓ N more`, and the footer. Keys live in
 * `keys/overlay.ts`; this paints the pure {@link ResumeState}.
 */
const Body = (props: { state: ResumeState }) => {
  const s = () => props.state
  const tab = () => activeTab(s())
  const convs = createMemo(() => filteredConvs(s()))
  const n = () => convs().length

  const win = createMemo(() => {
    const rows = Math.min(ROWS, Math.max(1, n()))
    let start = s().selected - Math.floor(rows / 2)
    start = Math.max(0, Math.min(start, Math.max(0, n() - rows)))
    return { start, rows, above: start, below: Math.max(0, n() - (start + rows)) }
  })
  const visible = createMemo(() => {
    const { start, rows } = win()
    return convs().slice(start, start + rows).map((c, i) => ({ c, idx: start + i }))
  })

  return (
    <box flexDirection="column" flexShrink={0}>
      {/* connection tab strip */}
      <box flexDirection="row">
        <For each={s().tabs}>
          {(t, i) => (
            <>
              {i() > 0 ? <text fg={tokens.text.dim}>{"   "}</text> : null}
              <text
                fg={i() === s().tab ? tokens.marker.select : tokens.text.muted}
                wrapMode="none"
                {...(i() === s().tab ? { backgroundColor: tokens.cursorLine } : {})}
              >
                {` ${t.label}${t.active ? ` ${glyph.activeTag}` : ""} `}
              </text>
            </>
          )}
        </For>
        <Show when={s().tabs.length > 1}>
          <text fg={tokens.text.dim} wrapMode="none">{"   (tab to cycle)"}</text>
        </Show>
      </box>
      <box height={1} />

      {/* search line */}
      <box flexDirection="row">
        <text fg={tokens.text.muted} wrapMode="none">{`/ ${s().filter}`}</text>
        <Cursor />
      </box>
      <box height={1} />

      {/* the active tab's conversations (or its load error / empty note) */}
      <Show
        when={tab()?.error === undefined}
        fallback={<text fg={tokens.state.error} wrapMode="none">{`  ${tab()?.error ?? ""}`}</text>}
      >
        <Show when={n() > 0} fallback={<text fg={tokens.text.dim} wrapMode="none">{"  (no conversations)"}</text>}>
          <Show when={win().above > 0}>
            <text fg={tokens.text.dim} wrapMode="none">{`   ${glyph.more.above} ${win().above} more`}</text>
          </Show>
          <For each={visible()}>
            {(row) => {
              const sel = () => row.idx === s().selected
              const age = relativeAge(row.c.createdAt)
              return (
                <box flexDirection="row" {...(sel() ? { backgroundColor: tokens.cursorLine } : {})}>
                  <text fg={sel() ? tokens.marker.select : tokens.text.muted}>{`${sel() ? glyph.pointer : " "} `}</text>
                  <text fg={sel() ? tokens.text.default : tokens.text.muted} wrapMode="none" flexGrow={1}>
                    {truncate(convLabel(row.c), 90)}
                  </text>
                  <text fg={tokens.text.dim} wrapMode="none">{`  ${age}`}</text>
                </box>
              )
            }}
          </For>
          <Show when={win().below > 0}>
            <text fg={tokens.text.dim} wrapMode="none">{`   ${glyph.more.below} ${win().below} more`}</text>
          </Show>
        </Show>
      </Show>

      <box height={1} />
      <box paddingLeft={2}>
        <KeyHints
          hints={[
            { key: "↑/↓", label: "Navigate" },
            { key: "tab", label: "Switch" },
            { key: "type", label: "search" },
            { key: "↵", label: "Resume" },
            { key: "esc", label: "Close" },
          ]}
        />
      </box>
    </box>
  )
}

export const ResumeBrowser = (props: { ctx: TuiContext }) => {
  const state = createMemo((): ResumeState | undefined => {
    const o: OverlayState = props.ctx.store.overlay()
    return o.kind === "resume" ? o.state : undefined
  })
  return <Show when={state()}>{(s) => <Body state={s()} />}</Show>
}
