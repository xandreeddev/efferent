import { SyntaxStyle } from "@opentui/core"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { themes } from "./theme.js"
import { terminalText } from "./state.js"
import type { TuiState } from "./state.js"
import { detailPreview, failureMessageSummary, filterRows, formatTokens, groupActivities } from "./presentation.entity.functions.js"

export const WINDOW_BLOCKS = 60
export interface AppActions {
  readonly commands?: ReadonlyArray<{ readonly name: string; readonly description: string }>
  readonly submit: (text: string) => void
  readonly palette: () => void
  readonly interrupt: () => void
  readonly quit: () => void
}

/** One conversation, one composer, one temporary inspector. */
export const App = (props: { state: TuiState; actions: AppActions; assistantName?: string }) => {
  const state = props.state
  const dimensions = useTerminalDimensions()
  const color = () => themes[state.themeName()]
  const composer = { current: undefined as TextareaRenderable | undefined }
  const editor = { current: undefined as TextareaRenderable | undefined }
  const scroll = { current: undefined as ScrollBoxRenderable | undefined }
  const details = { current: undefined as ScrollBoxRenderable | undefined }
  const [input, setInput] = createSignal("")
  const [commandSelection, setCommandSelection] = createSignal(0)
  const [dismissed, setDismissed] = createSignal(false)
  const suggestions = createMemo(() => !dismissed() && state.overlay().kind === "none" && /^\/[a-z-]*$/.test(input())
    ? (props.actions.commands ?? []).filter((command) => command.name.startsWith(input().slice(1))) : [])
  const suggestionRows = () => Math.max(1, Math.min(5, dimensions().height - 10))
  const suggestionStart = () => Math.max(0, commandSelection() - suggestionRows() + 1)
  const updateInput = (text: string) => { setInput(text); state.setComposerText(text); setCommandSelection(0); setDismissed(false) }
  const [secret, setSecret] = createSignal("")
  const [quitArmed, setQuitArmed] = createSignal(0)
  const [overlayHeight, setOverlayHeight] = createSignal(0)
  const menuRows = () => Math.max(1, overlayHeight() - 5)
  const menuStart = () => Math.max(0, state.selection() - menuRows() + 1)
  const menu = createMemo(() => { const overlay = state.overlay(); return overlay.kind === "menu" ? filterRows(overlay.rows, state.query()) : [] })
  const inspector = createMemo(() => { const overlay = state.overlay(); return overlay.kind === "inspector" ? filterRows(overlay.rows, state.query()) : [] })
  const selectedDetail = createMemo(() => inspector()[state.selection()])
  const inspectorRows = () => Math.max(1, Math.min(5, Math.floor((overlayHeight() - 5) / 3)))
  const inspectorStart = () => Math.max(0, state.selection() - inspectorRows() + 1)
  const syntax = createMemo(() => SyntaxStyle.fromStyles({
    default: { fg: color().text }, keyword: { fg: color().accent, bold: true }, string: { fg: color().warning },
    comment: { fg: color().muted, italic: true }, function: { fg: color().accent }, number: { fg: color().warning },
    "markup.heading": { fg: color().accent, bold: true }, "markup.raw": { fg: color().text }, "markup.strong": { bold: true },
  }))
  createEffect(() => { const value = syntax(); onCleanup(() => value.destroy()) })
  const filtered = createMemo(() => groupActivities(state.transcript().blocks).filter((block) => state.search().length === 0 || `${block.text}\n${block.detail}`.toLowerCase().includes(state.search().toLowerCase())))
  const end = () => state.following() ? filtered().length : Math.min(state.windowEnd(), filtered().length)
  const blocks = createMemo(() => filtered().slice(Math.max(0, end() - WINDOW_BLOCKS), end()))
  const blockMap = createMemo(() => new Map(blocks().map((block) => [block.id, block])))
  const blockIds = createMemo(() => blocks().map((block) => block.id))
  const running = () => state.transcript().runId.length > 0
  const active = createMemo(() => state.transcript().blocks.findLast((block) => block.status === "running" && block.kind !== "assistant" && block.kind !== "user"))
  const heartbeat = () => {
    if (!running()) return state.transcript().status
    const phase = active()?.role ?? (active()?.category === "edit" ? "Editing" : active()?.category === "check" ? "Checking" : "Working")
    const elapsed = state.transcript().startedAt > 0 ? ` · ${Math.max(0, Math.floor((state.now() - state.transcript().startedAt) / 1000))}s` : ""
    return `${phase}${elapsed}`
  }
  const headerModel = () => {
    const selection = terminalText(active()?.model || state.model())
    if (dimensions().width >= 110 || !selection.includes(":")) return selection
    const boundary = selection.indexOf(":")
    return `${selection.slice(0, boundary + 1)}${selection.slice(boundary + 1).split("/").at(-1)}`
  }
  const submit = () => {
    const text = composer.current?.plainText ?? ""
    if (text.trim().length === 0 || state.overlay().kind !== "none") return
    const command = suggestions()[commandSelection()]
    composer.current?.setText(""); updateInput(""); state.setComposerMode("insert"); props.actions.submit(command === undefined ? text : `/${command.name}`)
  }
  createEffect(() => { const draft = state.draft(); if (draft.revision > 0) { composer.current?.setText(draft.text); updateInput(draft.text); state.setComposerMode("insert") } })
  createEffect(() => {
    const overlay = state.overlay()
    setSecret(overlay.kind === "edit" && overlay.secret === true ? overlay.value : "")
    if (overlay.kind === "none") composer.current?.focus()
    else { composer.current?.blur(); if (overlay.kind === "edit") editor.current?.focus() }
  })
  const page = (direction: number) => {
    state.setWindowEnd(Math.min(filtered().length, Math.max(WINDOW_BLOCKS, end() + direction * (WINDOW_BLOCKS / 2))))
    state.setFollowing(direction > 0 && state.windowEnd() >= filtered().length)
    queueMicrotask(() => scroll.current?.scrollTo(direction < 0 ? 0 : scroll.current.scrollHeight))
  }
  const filterInput = (text: string) => { state.setFiltering(true); state.setQuery(state.query() + text.replace(/[\x00-\x1f\x7f]/g, "")); details.current?.scrollTo(0) }
  const composerMotions = new Map<string, () => void>([
    ["h", () => composer.current?.moveCursorLeft()], ["l", () => composer.current?.moveCursorRight()],
    ["j", () => composer.current?.moveCursorDown()], ["k", () => composer.current?.moveCursorUp()],
    ["w", () => composer.current?.moveWordForward()], ["b", () => composer.current?.moveWordBackward()],
    ["0", () => composer.current?.gotoLineStart()], ["$", () => composer.current?.gotoLineTextEnd()],
    ["x", () => composer.current?.deleteChar()], ["u", () => composer.current?.undo()],
  ])
  const overlayHint = () => state.filtering() ? "Ctrl+J/K ↑↓ select · Enter open · Ctrl+G browse · Esc close"
    : state.inspecting() ? "j/k ↑↓ scroll · h/Enter back · Esc close"
    : `j/k ↑↓ select · l/Enter ${state.overlay().kind === "inspector" ? "detail" : "open"} · / filter · h/Esc close`
  usePaste((event) => {
    const overlay = state.overlay()
    if (overlay.kind === "menu" || overlay.kind === "inspector") { event.preventDefault(); filterInput(new TextDecoder().decode(event.bytes)); return }
    if (overlay.kind === "none") state.setComposerMode("insert")
    if (overlay.kind !== "edit" || overlay.secret !== true) return
    event.preventDefault(); setSecret((value) => value + new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, ""))
  })
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      if (Date.now() - quitArmed() < 1200) props.actions.quit()
      else { setQuitArmed(Date.now()); if (running()) props.actions.interrupt(); state.setNotice("Press Ctrl+C again to exit") }
      return
    }
    if (key.ctrl && key.name === "p") { key.preventDefault(); props.actions.palette(); return }
    const overlay = state.overlay()
    if (key.name === "escape") {
      key.preventDefault()
      if (overlay.kind === "approval") overlay.answer(false)
      else if (overlay.kind !== "none") state.setOverlay({ kind: "none" })
      else if (suggestions().length > 0) setDismissed(true)
      else if (running()) props.actions.interrupt()
      else state.setComposerMode("normal")
      return
    }
    if (overlay.kind === "approval" && ["y", "n"].includes(key.name)) { key.preventDefault(); overlay.answer(key.name === "y"); return }
    if (overlay.kind === "menu" || overlay.kind === "inspector") {
      key.preventDefault()
      const rows = overlay.kind === "menu" ? menu() : inspector()
      const down = key.name === "down" || key.name === "linefeed" && !key.meta || key.ctrl && key.name === "j" || !state.filtering() && !key.ctrl && key.name === "j"
      const up = key.name === "up" || key.ctrl && key.name === "k" || !state.filtering() && !key.ctrl && key.name === "k"
      if (overlay.kind === "inspector" && ["pageup", "pagedown"].includes(key.name)) details.current?.scrollBy({ x: 0, y: key.name === "pageup" ? -10 : 10 })
      else if (down || up) {
        if (overlay.kind === "inspector" && state.inspecting()) details.current?.scrollBy({ x: 0, y: up ? -1 : 1 })
        else { state.setSelection((value) => Math.max(0, Math.min(rows.length - 1, value + (up ? -1 : 1)))); details.current?.scrollTo(0) }
      }
      else if (key.name === "return") { if (overlay.kind === "menu") menu()[state.selection()]?.select(); else state.setInspecting((value) => !value) }
      else if (key.ctrl && key.name === "g") state.setFiltering(false)
      else if (!state.filtering() && !key.ctrl && ["h", "left"].includes(key.name)) { if (state.inspecting()) state.setInspecting(false); else state.setOverlay({ kind: "none" }) }
      else if (!state.filtering() && !key.ctrl && ["l", "right"].includes(key.name)) { if (overlay.kind === "menu") menu()[state.selection()]?.select(); else state.setInspecting(true) }
      else if (!state.filtering() && key.sequence === "/") state.setFiltering(true)
      else if (key.name === "backspace") { state.setFiltering(true); state.setQuery(Array.from(state.query()).slice(0, -1).join("")); details.current?.scrollTo(0) }
      else if (!key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(key.sequence)) filterInput(key.sequence)
      return
    }
    if (overlay.kind === "text" || overlay.kind === "approval") {
      if (overlay.kind === "text" && key.name === "h") { key.preventDefault(); state.setOverlay({ kind: "none" }); return }
      if (["up", "down", "pageup", "pagedown", "j", "k", "linefeed"].includes(key.name)) { key.preventDefault(); details.current?.scrollBy({ x: 0, y: key.name === "up" || key.name === "k" ? -1 : key.name === "down" || key.name === "j" || key.name === "linefeed" ? 1 : key.name === "pageup" ? -10 : 10 }) }
      return
    }
    if (overlay.kind === "edit") {
      if (key.ctrl && key.name === "s") { key.preventDefault(); overlay.save(overlay.secret === true ? secret() : editor.current?.plainText ?? overlay.value); return }
      if (overlay.secret === true) {
        key.preventDefault()
        if (key.name === "backspace") setSecret((value) => Array.from(value).slice(0, -1).join(""))
        else if (!key.ctrl && !key.meta && key.sequence.length > 0 && !/[\x00-\x1f\x7f]/.test(key.sequence)) setSecret((value) => value + key.sequence)
      }
      return
    }
    if (overlay.kind !== "none") return
    if (key.ctrl && key.name === "u") { key.preventDefault(); composer.current?.setText(""); updateInput(""); state.setComposerMode("insert"); return }
    if (suggestions().length > 0 && !key.ctrl && !key.meta) {
      if (["up", "down"].includes(key.name)) { key.preventDefault(); setCommandSelection((value) => Math.max(0, Math.min(suggestions().length - 1, value + (key.name === "up" ? -1 : 1)))); return }
      if (key.name === "tab") {
        key.preventDefault()
        const command = suggestions()[commandSelection()]
        if (command !== undefined) { const text = `/${command.name} `; composer.current?.setText(text); composer.current?.gotoBufferEnd(); updateInput(text) }
        return
      }
    }
    if (key.ctrl && key.name === "o") { key.preventDefault(); state.inspectTranscript(); return }
    if (state.composerMode() === "normal" && !key.ctrl && !key.meta) {
      key.preventDefault()
      const name = key.shift ? key.sequence : key.name
      if (name === "return") submit()
      else if (["i", "a", "I", "A"].includes(name)) {
        if (name === "a") composer.current?.moveCursorRight()
        if (name === "I") composer.current?.gotoLineStart()
        if (name === "A") composer.current?.gotoLineTextEnd()
        state.setComposerMode("insert")
      } else composerMotions.get(name)?.()
      return
    }
    if (key.name === "pageup" || key.name === "pagedown") { key.preventDefault(); page(key.name === "pageup" ? -1 : 1) }
    if (key.ctrl && key.name === "end") { key.preventDefault(); state.setFollowing(true) }
  })

  return <box width="100%" height="100%" flexDirection="column" backgroundColor={color().background} paddingX={1}>
    <box id="session-header" height={1} flexShrink={0} flexDirection="row">
      <text fg={color().accent} width={9} flexShrink={0} wrapMode="none"><b>{props.assistantName ?? "efferent"}</b></text>
      <text id="header-workspace" fg={color().muted} minWidth={0} maxWidth={Math.floor((dimensions().width - 2) / 4)} flexShrink={1} wrapMode="none" truncate>{terminalText(state.session().workspace.split("/").at(-1) ?? "")}</text>
      <text id="header-mode" fg={color().muted} marginLeft={1} flexShrink={0} wrapMode="none">{`· ${state.mode()}`}</text>
      <text id="header-model" fg={color().muted} marginLeft={1} width={0} minWidth={0} flexGrow={1} wrapMode="none" truncate>{headerModel() && dimensions().width >= 80 ? `· ${headerModel()}` : ""}</text>
      <text id="header-status" fg={state.transcript().status === "Failed" ? color().danger : color().accent} marginLeft={1} flexShrink={0} maxWidth={Math.max(12, Math.floor(dimensions().width / 3))} wrapMode="none" truncate>{terminalText(heartbeat())}</text>
    </box>
    <Show when={state.overlay().kind === "none"} fallback={
      <box ref={(value) => { setOverlayHeight(value.height); value.onSizeChange = () => setOverlayHeight(value.height) }} minHeight={0} overflow="hidden" flexGrow={1} flexDirection="column" border borderColor={color().rule} paddingX={1}>
        <text fg={color().accent} height={1} flexShrink={0} wrapMode="none">{(() => { const overlay = state.overlay(); return terminalText(overlay.kind === "approval" ? "Approval required" : "title" in overlay ? overlay.title : "") })()}</text>
        <Show when={state.overlay().kind === "menu" || state.overlay().kind === "inspector"}>
          <text fg={state.filtering() ? color().text : color().muted} height={1} flexShrink={0} wrapMode="none">{state.filtering() || state.query() ? `Filter: ${state.query()}` : "Browse · / filter"}</text>
        </Show>
        <Show when={state.overlay().kind === "menu"}>
          <box flexGrow={1} minHeight={0} flexDirection="column" overflow="hidden">
            <For each={menu().slice(menuStart(), menuStart() + menuRows())}>{(row, index) =>
              <box flexDirection="row" height={1} flexShrink={0} overflow="hidden" backgroundColor={index() + menuStart() === state.selection() ? color().surface : color().background} onMouseDown={() => row.select()}>
                <text fg={color().accent} width={3} flexShrink={0}>{index() + menuStart() === state.selection() ? "›" : " "}</text>
                <text fg={color().text} width={dimensions().width < 75 ? "auto" : Math.min(38, Math.floor(dimensions().width / 2))} flexGrow={dimensions().width < 75 ? 1 : 0} wrapMode="none">{terminalText(row.label)}</text>
                <Show when={dimensions().width >= 75}><text fg={color().muted} marginLeft={2} minWidth={0} flexGrow={1} wrapMode="none">{terminalText(row.detail)}</text></Show>
              </box>
            }</For>
            <Show when={menu().length === 0}><text fg={color().muted}>No matching actions</text></Show>
          </box>
          <text fg={color().muted} height={1} flexShrink={0} wrapMode="none">{overlayHint()}</text>
        </Show>
        <Show when={state.overlay().kind === "inspector"}>
          <Show when={!state.inspecting()}>
            <For each={inspector().slice(inspectorStart(), inspectorStart() + inspectorRows())}>{(row, index) =>
              <box height={1} flexShrink={0} flexDirection="row" backgroundColor={index() + inspectorStart() === state.selection() ? color().surface : color().background} onMouseDown={() => state.setSelection(index() + inspectorStart())}>
                <text fg={row.status === "failed" ? color().danger : color().accent} width={3} flexShrink={0}>{index() + inspectorStart() === state.selection() ? "›" : " "}</text>
                <text fg={color().text} minWidth={0} flexGrow={1} wrapMode="none">{terminalText(row.label)}</text>
                <text fg={color().muted} marginLeft={1} flexShrink={0} wrapMode="none">{terminalText(row.detail)}</text>
              </box>
            }</For>
          </Show>
          <scrollbox ref={(value) => { details.current = value }} minHeight={0} flexGrow={1} border={["top"]} borderColor={color().rule}>
            <text fg={color().text} wrapMode="word">{terminalText(detailPreview(selectedDetail()?.text ?? "No matching activity"))}</text>
          </scrollbox>
          <text fg={color().muted} height={1} flexShrink={0} wrapMode="none">{overlayHint()}</text>
        </Show>
        <Show when={state.overlay().kind === "text" || state.overlay().kind === "approval"}>
          <scrollbox ref={(value) => { details.current = value }} minHeight={0} flexGrow={1}><text fg={color().text} wrapMode="word">{(() => { const overlay = state.overlay(); return terminalText(overlay.kind === "text" ? overlay.text : overlay.kind === "approval" ? overlay.description : "") })()}</text></scrollbox>
          <text fg={color().warning} height={1} flexShrink={0} wrapMode="none">{state.overlay().kind === "approval" ? "y approve this action · n / Esc deny" : "j/k scroll · h/Esc close"}</text>
        </Show>
        <Show when={state.overlay().kind === "edit"}>
          <Show when={(() => { const overlay = state.overlay(); return overlay.kind === "edit" && overlay.secret === true })()} fallback={
            <textarea ref={(value) => { editor.current = value; value.focus() }} initialValue={(() => { const overlay = state.overlay(); return overlay.kind === "edit" ? overlay.value : "" })()} keyBindings={[{ name: "a", ctrl: true, action: "select-all" }]} minHeight={0} flexGrow={1} wrapMode="word" textColor={color().text} backgroundColor={color().surface} />
          }><text fg={color().accent} flexGrow={1}>{"•".repeat(secret().length)}</text></Show>
          <text fg={color().muted} height={1} flexShrink={0}>Ctrl+S save · Esc cancel</text>
        </Show>
      </box>
    }>
      <Show when={state.search().length > 0}><text fg={color().muted} height={1} flexShrink={0}>Search: {terminalText(state.search())} · /search clears</text></Show>
      <Show when={filtered().length === 0}>
        <box flexGrow={1} minHeight={0} justifyContent="center" flexDirection="column" paddingLeft={1}>
          <text fg={color().text}><b>{state.search() ? "No matching transcript" : "What are we working on?"}</b></text>
          <Show when={!state.search()}><text fg={color().muted} marginTop={1}>Describe a task to inspect, edit, and verify.</text>
            <text fg={color().accent} marginTop={1}>/setup to connect · / for actions</text></Show>
        </box>
      </Show>
      <Show when={filtered().length > 0}>
        <Show when={filtered().length > WINDOW_BLOCKS || !state.following()}><text fg={color().muted} height={1} flexShrink={0}>{state.following() ? `${Math.max(0, filtered().length - WINDOW_BLOCKS)} earlier blocks · PgUp to browse` : `History · ${end()} / ${filtered().length} blocks · Ctrl+End follows output`}</text></Show>
        <scrollbox ref={(value) => { scroll.current = value }} minHeight={0} flexGrow={1} stickyScroll={state.following()} stickyStart="bottom" viewportCulling onMouseScroll={() => { if (state.following()) { state.setWindowEnd(filtered().length); state.setFollowing(false) } }}>
          <For each={blockIds()}>{(id) => {
            const initial = blockMap().get(id)!
            const block = createMemo(() => blockMap().get(id) ?? initial)
            return <box id={`transcript:${id}`} flexDirection="column" flexShrink={0} marginBottom={block().kind === "tool" ? 0 : 1}>
              <box flexDirection="row" onMouseDown={() => state.toggle(block().id)}>
                <text fg={block().kind === "user" ? color().accent : block().status === "failed" ? color().danger : color().muted} wrapMode="word">{terminalText(`${block().kind === "tool" ? (state.expanded().has(block().id) ? "▾" : "▸") : "•"} ${block().kind === "assistant" ? props.assistantName ?? "Assistant" : block().kind === "user" ? "You" : block().text}${block().status === "pending" ? " · queued" : block().status === "running" && block().kind === "tool" ? " · running" : block().status === "failed" ? " · failed" : ""}${block().durationMs === undefined || block().durationMs! < 100 ? "" : ` · ${(block().durationMs! / 1000).toFixed(1)}s`}`)}</text>
              </box>
              <Show when={block().kind === "assistant"} fallback={<Show when={block().kind === "user"}><text fg={color().text} wrapMode="word">{terminalText(block().text)}</text></Show>}>
                <markdown id={`markdown:${id}`} content={terminalText(block().text).slice(-48000)} syntaxStyle={syntax()} streaming={block().status === "running"} conceal={true} />
              </Show>
              <Show when={block().kind === "tool" && (block().status === "failed" || block().status === "cancelled") && !state.expanded().has(block().id)}><text fg={color().muted} maxHeight={2} wrapMode="word">{terminalText(block().summary || "The tool did not complete. Ctrl+O for details.")}</text></Show>
              <Show when={block().kind === "notice" && (block().status === "failed" || block().status === "cancelled") && !state.expanded().has(block().id) && block().detail.length > 0}><text fg={color().muted} maxHeight={2} wrapMode="word">{terminalText(block().summary || failureMessageSummary(block().detail))}</text></Show>
              <Show when={state.expanded().has(block().id) && block().detail.length > 0}><text fg={color().muted} wrapMode="word">{terminalText(block().detail).slice(0, 32000)}</text></Show>
            </box>
          }}</For>
        </scrollbox>
      </Show>
    </Show>
    <Show when={suggestions().length > 0}>
      <box id="slash-commands" flexDirection="column" flexShrink={0} border={["top"]} borderColor={color().rule}>
        <text fg={color().muted} height={1} wrapMode="none">Commands · ↑↓ select · Tab complete · Enter run · Esc close</text>
        <For each={suggestions().slice(suggestionStart(), suggestionStart() + suggestionRows())}>{(command, index) =>
          <box height={1} flexShrink={0} flexDirection="row" backgroundColor={index() + suggestionStart() === commandSelection() ? color().surface : color().background} onMouseDown={() => { composer.current?.setText(""); updateInput(""); props.actions.submit(`/${command.name}`) }}>
            <text fg={color().accent} width={18} flexShrink={0} wrapMode="none">{`${index() + suggestionStart() === commandSelection() ? "›" : " "} /${command.name}`}</text>
            <text fg={color().muted} flexGrow={1} minWidth={0} wrapMode="none">{command.description}</text>
          </box>
        }</For>
      </box>
    </Show>
    <Show when={state.notice().length > 0}><text fg={color().warning} height={Math.min(3, Math.ceil(state.notice().length / Math.max(1, dimensions().width - 2)))} flexShrink={0} wrapMode="word">{terminalText(state.notice())}</text></Show>
    <box id="composer" flexDirection="column" border={["top"]} borderColor={color().rule} flexShrink={0}>
      <textarea ref={(value) => { composer.current = value; value.focus(); value.onContentChange = () => updateInput(value.plainText) }}
        height={Math.min(5, Math.max(1, input().split("\n").reduce((rows, line) => rows + Math.max(1, Math.ceil(Array.from(line).length / Math.max(1, dimensions().width - 2))), 0)))} flexShrink={0} wrapMode="word" textColor={color().text} backgroundColor={color().background}
        placeholder={running() ? "Steer the current task…" : "Describe a task, or / for actions"} placeholderColor={color().muted} cursorStyle={{ style: state.composerMode() === "normal" ? "block" : "line", blinking: true }}
        keyBindings={[{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }, { name: "return", meta: true, action: "newline" }]} onSubmit={submit} />
      <text fg={color().muted} height={1} flexShrink={0} wrapMode="none">{`${state.composerMode() === "normal" ? "NORMAL · hjkl move · w/b words · i insert · Enter send" : `${running() ? "Enter steer · Esc stop" : `Enter send${dimensions().width >= 65 ? " · Alt+Enter newline" : ""} · Esc normal`}`} · ^O inspect${dimensions().width >= 65 ? " · ^P actions" : ""}${dimensions().width >= 110 && state.transcript().tokens > 0 ? ` · ctx ${formatTokens(state.transcript().tokens)}` : ""}`}</text>
    </box>
  </box>
}
