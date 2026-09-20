import { SyntaxStyle } from "@opentui/core"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { themes } from "./theme.js"
import { terminalText } from "./state.js"
import type { TuiState } from "./state.js"

export const WINDOW_BLOCKS = 60
export interface AppActions {
  readonly commands?: ReadonlyArray<{ readonly name: string; readonly description: string }>
  readonly submit: (text: string) => void
  readonly palette: () => void
  readonly interrupt: () => void
  readonly quit: () => void
}

export const App = (props: { state: TuiState; actions: AppActions }) => {
  const state = props.state
  const dimensions = useTerminalDimensions()
  const color = () => themes[state.themeName()]
  const composer = { current: undefined as TextareaRenderable | undefined }
  const editor = { current: undefined as TextareaRenderable | undefined }
  const scroll = { current: undefined as ScrollBoxRenderable | undefined }
  const [input, setInput] = createSignal("")
  const [commandSelection, setCommandSelection] = createSignal(0)
  const [dismissed, setDismissed] = createSignal(false)
  const suggestions = createMemo(() => !dismissed() && state.overlay().kind === "none" && /^\/[a-z-]*$/.test(input())
    ? (props.actions.commands ?? []).filter((command) => command.name.startsWith(input().slice(1))) : [])
  const suggestionRows = () => Math.max(1, Math.min(6, dimensions().height - 14))
  const suggestionStart = () => Math.max(0, commandSelection() - suggestionRows() + 1)
  const updateInput = (text: string) => { setInput(text); setCommandSelection(0); setDismissed(false) }
  const [secret, setSecret] = createSignal("")
  const [quitArmed, setQuitArmed] = createSignal(0)
  const [overlayHeight, setOverlayHeight] = createSignal(0)
  const compact = () => dimensions().height < 24
  const menuRows = () => Math.max(1, overlayHeight() - (compact() ? 4 : 8))
  const menuStart = () => Math.max(0, state.selection() - menuRows() + 1)
  const syntax = createMemo(() => SyntaxStyle.fromStyles({
    default: { fg: color().text }, keyword: { fg: color().accent, bold: true }, string: { fg: color().warning },
    comment: { fg: color().muted, italic: true }, function: { fg: color().accent }, number: { fg: color().warning },
    "markup.heading": { fg: color().accent, bold: true }, "markup.raw": { fg: color().text }, "markup.strong": { bold: true },
  }))
  createEffect(() => { const value = syntax(); onCleanup(() => value.destroy()) })
  const filtered = createMemo(() => state.transcript().blocks.filter((block) => state.search().length === 0 || `${block.text}\n${block.detail}`.toLowerCase().includes(state.search().toLowerCase())))
  const end = () => state.following() ? filtered().length : Math.min(state.windowEnd(), filtered().length)
  const blocks = createMemo(() => filtered().slice(Math.max(0, end() - WINDOW_BLOCKS), end()))
  // Key the native renderers by durable IDs; delta projections replace block objects.
  const blockMap = createMemo(() => new Map(blocks().map((block) => [block.id, block])))
  const blockIds = createMemo(() => blocks().map((block) => block.id))
  const submit = () => {
    const text = composer.current?.plainText ?? ""
    if (text.trim().length === 0 || state.overlay().kind !== "none") return
    const command = suggestions()[commandSelection()]
    composer.current?.setText(""); updateInput(""); props.actions.submit(command === undefined ? text : `/${command.name}`)
  }
  createEffect(() => { const draft = state.draft(); if (draft.revision > 0) { composer.current?.setText(draft.text); updateInput(draft.text) } })
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
  usePaste((event) => {
    const overlay = state.overlay()
    if (overlay.kind !== "edit" || overlay.secret !== true) return
    event.preventDefault()
    setSecret((value) => value + new TextDecoder().decode(event.bytes).replace(/[\r\n]/g, ""))
  })
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault()
      if (Date.now() - quitArmed() < 1200) props.actions.quit()
      else { setQuitArmed(Date.now()); state.setNotice("Press Ctrl+C again to exit · Esc cancels current work") }
      return
    }
    if (key.ctrl && key.name === "p") { key.preventDefault(); props.actions.palette(); return }
    const overlay = state.overlay()
    if (key.name === "escape") {
      key.preventDefault()
      if (overlay.kind === "approval") overlay.answer(false)
      else if (overlay.kind !== "none") state.setOverlay({ kind: "none" })
      else if (suggestions().length > 0) setDismissed(true)
      else if (state.transcript().runId.length > 0) props.actions.interrupt()
      else { composer.current?.setText(""); setInput("") }
      return
    }
    if (overlay.kind === "approval" && ["y", "n"].includes(key.name)) { key.preventDefault(); overlay.answer(key.name === "y"); return }
    if (overlay.kind === "menu") {
      if (["up", "down"].includes(key.name)) { key.preventDefault(); state.setSelection((value) => Math.max(0, Math.min(overlay.rows.length - 1, value + (key.name === "up" ? -1 : 1)))) }
      if (key.name === "return") { key.preventDefault(); overlay.rows[state.selection()]?.select() }
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
    if (suggestions().length > 0 && !key.ctrl && !key.meta) {
      if (["up", "down"].includes(key.name)) {
        key.preventDefault(); setCommandSelection((value) => Math.max(0, Math.min(suggestions().length - 1, value + (key.name === "up" ? -1 : 1)))); return
      }
      if (key.name === "tab") {
        key.preventDefault()
        const command = suggestions()[commandSelection()]
        if (command !== undefined) { const text = `/${command.name} `; composer.current?.setText(text); composer.current?.gotoBufferEnd(); updateInput(text) }
        return
      }
    }
    if (key.ctrl && key.name === "o") {
      key.preventDefault()
      const tools = blocks().filter((block) => block.kind === "tool")
      const collapse = tools.every((block) => state.expanded().has(block.id))
      tools.filter((block) => state.expanded().has(block.id) === collapse).forEach((block) => state.toggle(block.id))
    }
    if (key.name === "pageup" || key.name === "pagedown") { key.preventDefault(); page(key.name === "pageup" ? -1 : 1) }
    if (key.ctrl && key.name === "end") { key.preventDefault(); state.setFollowing(true) }
  })

  return <box width="100%" height="100%" flexDirection="column" backgroundColor={color().background} paddingX={2} paddingY={1}>
    <box height={2} flexShrink={0} flexDirection="row">
      <text fg={color().accent} width={8} flexShrink={0} wrapMode="none"><b>efferent</b></text>
      <text fg={color().muted} width={0} minWidth={0} flexGrow={1} wrapMode="none">{` / ${state.session().profile} · ${state.session().workspace.split("/").at(-1)}${state.model() && dimensions().width >= 80 ? ` · ${state.model()}` : ""}`}</text>
      <text fg={state.transcript().status === "Failed" ? color().danger : color().accent} flexShrink={0} wrapMode="none">{state.transcript().status}</text>
    </box>
    <Show when={state.overlay().kind === "none"} fallback={
      <box ref={(value) => { setOverlayHeight(value.height); value.onSizeChange = () => setOverlayHeight(value.height) }} minHeight={0} overflow="hidden" flexGrow={1} flexDirection="column" border borderColor={color().rule} paddingX={1} paddingY={compact() ? 0 : 1}>
        <text fg={color().accent} height={compact() ? 1 : 2} flexShrink={0} wrapMode="none">{(() => { const overlay = state.overlay(); return overlay.kind === "approval" ? "Approval required" : "title" in overlay ? overlay.title : "" })()}</text>
        <Show when={state.overlay().kind === "menu"}>
          <For each={(() => { const overlay = state.overlay(); return overlay.kind === "menu" ? overlay.rows.slice(menuStart(), menuStart() + menuRows()) : [] })()}>{(row, index) =>
            <box flexDirection="row" height={1} flexShrink={0} overflow="hidden" backgroundColor={index() + menuStart() === state.selection() ? color().surface : color().background} onMouseDown={() => row.select()}>
              <text fg={color().accent} width={3} flexShrink={0}>{index() + menuStart() === state.selection() ? "›" : " "}</text>
              <text fg={color().text} width={dimensions().width < 75 ? "auto" : Math.min(48, Math.floor(dimensions().width / 2))} flexGrow={dimensions().width < 75 ? 1 : 0} wrapMode="none">{terminalText(row.label)}</text>
              <Show when={dimensions().width >= 75}><text fg={color().muted} marginLeft={2} minWidth={0} flexGrow={1} wrapMode="none">{terminalText(row.detail)}</text></Show>
            </box>
          }</For>
          <text fg={color().muted} marginTop={compact() ? 0 : 1} height={1} flexShrink={0} wrapMode="none">↑↓ select · Enter open · Esc close</text>
        </Show>
        <Show when={state.overlay().kind === "text" || state.overlay().kind === "approval"}>
          <scrollbox flexGrow={1}><text fg={color().text} wrapMode="word">{(() => { const overlay = state.overlay(); return terminalText(overlay.kind === "text" ? overlay.text : overlay.kind === "approval" ? overlay.description : "") })()}</text></scrollbox>
          <text fg={color().warning}>{state.overlay().kind === "approval" ? "y approve this action · n / Esc deny" : "Esc close"}</text>
        </Show>
        <Show when={state.overlay().kind === "edit"}>
          <Show when={(() => { const overlay = state.overlay(); return overlay.kind === "edit" && overlay.secret === true })()} fallback={
          <textarea ref={(value) => { editor.current = value; value.focus() }} initialValue={(() => { const overlay = state.overlay(); return overlay.kind === "edit" ? overlay.value : "" })()} keyBindings={[{ name: "a", ctrl: true, action: "select-all" }]} flexGrow={1} wrapMode="word" textColor={color().text} backgroundColor={color().surface} />
          }><text fg={color().accent} flexGrow={1}>{"•".repeat(secret().length)}</text></Show>
          <text fg={color().muted}>Ctrl+S save · Esc cancel</text>
        </Show>
      </box>
    }>
      <Show when={filtered().length === 0}>
        <box flexGrow={1} justifyContent="center" flexDirection="column" paddingLeft={2}>
          <text fg={color().text}><b>What are we working on?</b></text>
          <text fg={color().muted} marginTop={1}>Describe a task. Smith can inspect, edit, and verify this workspace.</text>
          <text fg={color().accent} marginTop={1}>/setup to get started · /plugins to configure or swap plugins</text>
        </box>
      </Show>
      <Show when={filtered().length > 0}>
        <text fg={color().muted} height={1}>{state.following() ? `${Math.max(0, filtered().length - WINDOW_BLOCKS)} earlier blocks · PgUp to browse` : `History · ${end()} / ${filtered().length} blocks · Ctrl+End follows output`}</text>
        <scrollbox ref={(value) => { scroll.current = value }} flexGrow={1} stickyScroll={state.following()} stickyStart="bottom" viewportCulling onMouseScroll={() => { if (state.following()) { state.setWindowEnd(filtered().length); state.setFollowing(false) } }}>
          <For each={blockIds()}>{(id) => {
            const initial = blockMap().get(id)!
            const block = createMemo(() => blockMap().get(id) ?? initial)
            return <box id={`transcript:${id}`} flexDirection="column" flexShrink={0} marginBottom={1}>
            <box flexDirection="row" onMouseDown={() => state.toggle(block().id)}>
              <text fg={block().kind === "user" ? color().accent : block().status === "failed" ? color().danger : color().muted}>{`${block().kind === "tool" ? (state.expanded().has(block().id) ? "▾" : "▸") : "•"} ${block().kind === "assistant" ? "Smith" : block().kind === "user" ? "You" : block().kind === "tool" ? block().text : block().text}${block().status === "pending" ? " · queued" : block().status === "running" ? " · running" : block().status === "failed" ? " · failed" : ""}`}</text>
            </box>
            <Show when={block().kind === "assistant"} fallback={<Show when={block().kind === "user"}><text fg={color().text} wrapMode="word">{terminalText(block().text)}</text></Show>}>
              <markdown id={`markdown:${id}`} content={terminalText(block().text).slice(-48000)} syntaxStyle={syntax()} streaming={block().status === "running"} conceal={true} />
            </Show>
            <Show when={(block().kind === "notice" || state.expanded().has(block().id)) && block().detail.length > 0}><text fg={color().muted} wrapMode="word">{terminalText(block().detail).slice(0, 32000)}</text></Show>
          </box>
          }}</For>
        </scrollbox>
      </Show>
    </Show>
    <Show when={suggestions().length > 0}>
      <box id="slash-commands" flexDirection="column" flexShrink={0} border={['top']} borderColor={color().rule}>
        <text fg={color().muted} height={1} wrapMode="none">Commands · ↑↓ select · Tab complete · Enter run · Esc close</text>
        <For each={suggestions().slice(suggestionStart(), suggestionStart() + suggestionRows())}>{(command, index) =>
          <box height={1} flexShrink={0} flexDirection="row" backgroundColor={index() + suggestionStart() === commandSelection() ? color().surface : color().background} onMouseDown={() => { composer.current?.setText(""); updateInput(""); props.actions.submit(`/${command.name}`) }}>
            <text fg={color().accent} width={18} flexShrink={0} wrapMode="none">{`${index() + suggestionStart() === commandSelection() ? "›" : " "} /${command.name}`}</text>
            <text fg={color().muted} flexGrow={1} minWidth={0} wrapMode="none">{command.description}</text>
          </box>
        }</For>
      </box>
    </Show>
    <Show when={state.notice().length > 0}><text fg={color().warning} height={1} wrapMode="none">{terminalText(state.notice())}</text></Show>
    <box flexDirection="column" border={['top']} borderColor={color().rule} marginTop={1} flexShrink={0} paddingTop={1}>
      <textarea ref={(value) => { composer.current = value; value.focus(); value.onContentChange = () => updateInput(value.plainText) }}
        height={Math.min(7, Math.max(3, input().split("\n").length))} flexShrink={0} wrapMode="word" textColor={color().text} backgroundColor={color().background}
        placeholder="Describe a task, or / for commands" placeholderColor={color().muted}
        keyBindings={[{ name: "return", action: "submit" }, { name: "return", shift: true, action: "newline" }, { name: "return", meta: true, action: "newline" }]} onSubmit={submit} />
      <text fg={color().muted} height={1} wrapMode="none">{dimensions().width < 65 ? "Enter send · Ctrl+P commands · Esc cancel" : `Enter send · Alt+Enter newline · Ctrl+P commands · Ctrl+O tools    ${state.transcript().tokens.toLocaleString()} tokens`}</text>
    </box>
  </box>
}
