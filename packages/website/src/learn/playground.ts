// The playground: wires the panes (model bar, code, chat, context) to the
// lesson runtime, which runs the real framework.
import { DEFAULT_CONFIG } from "./lesson1.source.ts"
import { readControls, setField } from "./config-edit.ts"
import type { ControlKey } from "./config-edit.ts"
import { echoChoice } from "./models/mock.ts"
import { loadModel, probeDevice } from "./models/registry.ts"
import type { Device } from "./models/registry.ts"
import type { LoadedModel, ModelChoice } from "./models/types.ts"
import { DEFAULT_TINY } from "./tiny-memory.source.ts"
import { mountChat } from "./panes/chat.ts"
import { mountContext } from "./panes/context.ts"
import { inspectorOf } from "./context-model.ts"
import { mountEditor } from "./panes/editor.ts"
import { mountInspector } from "./panes/inspector.ts"
import type { Section } from "./panes/editor.ts"
import { mountModels, setModelName } from "./panes/models.ts"
import type { LessonRuntime } from "./runtime.ts"

const root = document.querySelector<HTMLElement>(".wb-bench")
if (root) boot(root)

function boot(root: HTMLElement) {
  const q = <T extends HTMLElement>(selector: string): T => {
    const found = root.querySelector<T>(selector)
    if (!found) throw new Error(`playground markup is missing ${selector}`)
    return found
  }
  const grid = q("[data-grid]")
  const chip = q("[data-chip]")
  const buildBox = q("[data-build]")
  const syntaxBox = q("[data-syntax]")
  const keep = q<HTMLInputElement>("[data-keep]")

  const state = {
    runtime: undefined as LessonRuntime | undefined,
    runtimeReady: undefined as Promise<LessonRuntime> | undefined,
    model: undefined as LoadedModel | undefined,
    device: { gpu: { webgpu: false, f16: false, compatOnly: false }, chrome: { state: "unavailable", reason: "Checking…" } } as Device,
    built: false,
    running: false,
    loading: false,
  }

  // ── panes ───────────────────────────────────────────────────────────────
  const ctx = mountContext(q('[data-pane="context"]'))
  const inspector = mountInspector(q('[data-view="inspector"]'))
  const models = mountModels(q(".wb-modelbar"), { choose: (choice) => void chooseModel(choice) })
  const editor = mountEditor(q("[data-editor]"), { onRebuild: () => void rebuild(), onEdit: () => checkSyntaxSoon(), onFormat: () => void formatCode() })
  const chat = mountChat(q('[data-pane="chat"]'), {
    send: (text) => void send(text),
    stop: () => state.runtime?.stop(),
    newChat: () => { if (!state.running) void newConversation() },
  })

  // ── status ──────────────────────────────────────────────────────────────
  const setChip = (text: string, kind: "idle" | "ready" | "error") => { chip.textContent = text; chip.dataset.state = kind }
  const refresh = () => {
    const ready = Boolean(state.runtime && state.model && state.built)
    chat.setState({
      ready, running: state.running,
      hint: ready ? "" : state.model ? "Build the agent first (Rebuild in the Code pane)." : "Pick a model from the bar above.",
    })
    models.setBusy(state.loading || state.running)
    if (state.loading) return setChip("loading model…", "idle")
    if (!state.runtime) return setChip("starting…", "idle")
    if (!state.model) return setChip("pick a model", "idle")
    if (!state.built) return setChip("agent not built", "error")
    setChip("agent ready", "ready")
  }

  const ensureRuntime = (): Promise<LessonRuntime> => {
    state.runtimeReady ??= import("./runtime.ts").then(async ({ LessonRuntime }) => {
      state.runtime = await LessonRuntime.create()
      return state.runtime
    })
    return state.runtimeReady
  }

  /** Read the journal back and redraw the context panes from it. */
  const refreshInspector = async () => {
    const runtime = state.runtime
    if (!runtime) return
    const { events, report, captures } = await runtime.inspect()
    inspector.update(inspectorOf({ events, rows: report.rows, captures }), events)
  }

  // ── models ──────────────────────────────────────────────────────────────
  /** Echo takes over when the model in use is gone: freed for a new load, or lost with the GPU. */
  const fallBackToEcho = async () => {
    const echo = await loadModel(echoChoice, state.device, () => {})
    const runtime = await ensureRuntime()
    state.model = echo
    runtime.setModel(echo)
    setModelName(root, echoChoice.label)
    models.setActive(echoChoice.id)
  }

  const chooseModel = async (choice: ModelChoice) => {
    if (state.loading || state.running) return
    state.loading = true
    refresh()
    models.note(choice.id, "")
    // Two WebLLM engines share the GPU: the old one is unloaded and finished before the new one starts,
    // or its teardown takes the device from the new engine ("Device was lost").
    const previous = state.model
    const freed = previous !== undefined && previous.choice.kind === "webllm" && choice.kind === "webllm"
    try {
      if (freed) {
        models.progress({ fraction: 0, text: `Freeing the GPU from ${previous.choice.label}…` })
        await previous.dispose()
        state.model = undefined
      }
      const loaded = await loadModel(choice, state.device, (progress) => models.progress(progress))
      const runtime = await ensureRuntime()
      if (!freed) await previous?.dispose()
      state.model = loaded
      runtime.setModel(loaded)
      setModelName(root, choice.label)
      models.setActive(choice.id)
      models.close()
      if (chat.hasMessages()) chat.add("note", `Model: ${choice.label}`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const noGpu = /compatible GPU|WebGPU|adapter/i.test(reason)
      models.fail(choice.id, noGpu
        ? "This device has no usable GPU for WebGPU, so this model cannot run here. See how to enable it below, or use a CPU model."
        : `Could not load: ${reason}`)
      if (freed) {
        await fallBackToEcho()
        if (chat.hasMessages()) chat.add("note", `${choice.label} did not load, and ${previous.choice.label} was released to make room, so Echo is active.`)
      }
    } finally {
      models.progress(undefined)
      state.loading = false
      refresh()
    }
  }

  // ── code ────────────────────────────────────────────────────────────────
  const showBuild = (result: Awaited<ReturnType<LessonRuntime["rebuild"]>>) => {
    buildBox.replaceChildren()
    if (result.ok) {
      buildBox.dataset.state = "ok"
      const ids = result.plugins.map((id) => id.replace("@xandreed/", "")).join(", ")
      buildBox.textContent = `Agent.define accepted: ${ids}.`
      result.warnings.forEach((warning) => { buildBox.append(document.createElement("br"), `Note: ${warning}`) })
      if (result.restarted) buildBox.append(document.createElement("br"), "The memory strategy changed, so the conversation started again.")
    } else {
      buildBox.dataset.state = "error"
      buildBox.textContent = `Agent.define refused this: ${result.message}`
    }
  }

  /** A setting changed while a turn was running: rebuild when it ends, rather than dropping it. */
  let rebuildQueued = false
  const rebuild = async (): Promise<boolean> => {
    if (state.running) { rebuildQueued = true; return false }
    const runtime = await ensureRuntime()
    const result = await runtime.rebuild(editor.agentConfig(), editor.tinySource())
    state.built = result.ok
    showBuild(result)
    if (result.ok && result.restarted) { chat.clear(); ctx.resetTurn(); inspector.clear() }
    else if (result.ok && !keep.checked) await newConversation(false)
    refresh()
    syncControls()
    return result.ok
  }
  q("[data-rebuild]").addEventListener("click", () => void rebuild())
  const formatButton = q<HTMLButtonElement>("[data-format]")
  const formatCode = async () => {
    formatButton.disabled = true
    formatButton.textContent = "Formatting…"
    try {
      const result = await editor.format()
      // The edit re-runs the syntax check; a failure says why it could not be formatted.
      if (!result.ok) syntaxBox.textContent = result.message
    } finally {
      formatButton.disabled = false
      formatButton.textContent = "Format"
    }
  }
  formatButton.addEventListener("click", () => void formatCode())
  q("[data-reset-code]").addEventListener("click", () => {
    editor.setAgentConfig(DEFAULT_CONFIG)
    editor.setTinySource(DEFAULT_TINY)
    void rebuild()
  })

  let syntaxTimer: ReturnType<typeof setTimeout> | undefined
  const checkSyntaxSoon = () => {
    clearTimeout(syntaxTimer)
    syntaxTimer = setTimeout(() => {
      try {
        new Function(`return (${editor.file() === "agent" ? editor.agentConfig() : editor.tinySource()}\n)`)
        syntaxBox.textContent = ""
      } catch (error) {
        syntaxBox.textContent = error instanceof Error ? error.message : String(error)
      }
      syncControls()
    }, 350)
  }
  root.querySelectorAll<HTMLButtonElement>("[data-file]").forEach((tab) => tab.addEventListener("click", () => showFile(tab.dataset.file as "agent" | "tiny")))
  const showFile = (file: "agent" | "tiny") => {
    editor.showFile(file)
    root.querySelectorAll<HTMLButtonElement>("[data-file]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.file === file)))
    checkSyntaxSoon()
  }

  // ── chat ────────────────────────────────────────────────────────────────
  /** Wipe the chat, the journal behind it and everything the context panes show of it. */
  const newConversation = async (announce = true) => {
    await state.runtime?.reset()
    chat.clear()
    ctx.resetTurn()
    inspector.clear()
    if (announce) refresh()
  }

  /** The window refused a request it cannot fit: say why, and give the two ways out. */
  const explainBudget = (messageBudget: number) => {
    // The framework counts the system prompt and tool schemas outside the message budget; the learner sees the whole figure.
    const budget = readControls(editor.agentConfig()).budgetTokens ?? messageBudget
    const item = chat.add("error", `The window could not fit this request in a ${budget}-token budget. Besides your message it carries the system prompt and a ledger note for every turn it dropped, and that note grows by one line per dropped turn (your message and the reply, each cut to 240 characters), so a very small budget works for a few turns and then stops. Your message is already in the journal, so sending again fails the same way until the budget goes up or the context is cleared.`)
    const actions = document.createElement("div")
    actions.className = "msg-actions"
    const raised = Math.min(3000, Math.max(600, budget * 2))
    const raise = document.createElement("button")
    raise.type = "button"
    raise.className = "btn btn-quiet"
    raise.textContent = `Raise budget to ${raised}`
    raise.addEventListener("click", async () => {
      const next = setField(editor.agentConfig(), "budgetTokens", raised)
      if (next === undefined) return
      editor.setAgentConfig(next)
      await rebuild()
      syncControls()
      actions.remove()
    })
    const clear = document.createElement("button")
    clear.type = "button"
    clear.className = "btn btn-quiet"
    clear.textContent = "Clear context"
    clear.addEventListener("click", () => void newConversation())
    actions.append(raise, clear)
    item.append(actions)
  }

  let t0 = 0
  const send = async (text: string) => {
    const runtime = state.runtime
    if (!runtime || state.running || !state.built || !state.model) return
    chat.add("user", text)
    const live = chat.add("agent", "")
    live.dataset.live = ""
    let reply = ""
    ctx.resetTurn()
    t0 = performance.now()
    window.dispatchEvent(new CustomEvent("learn:start"))
    state.running = true
    refresh()
    let steps = 0
    try {
      const result = await runtime.send(text, {
        onEvent: (event) => {
          const e = event as unknown as Record<string, unknown>
          if (e._tag === "assistant.delta" && e.channel === "text") { reply += String(e.delta); chat.setReply(live, reply) }
          if (e._tag === "step.started") { steps += 1; ctx.stat("steps", String(steps)) }
          ctx.event(e, t0)
          window.dispatchEvent(new CustomEvent("learn:event", { detail: event }))
        },
      })
      live.removeAttribute("data-live")
      if (result.outcome === "stopped") { if (!reply) live.remove(); chat.add("note", "Stopped.") }
      else chat.setReply(live, result.text.length > 0 ? result.text : reply || "(the model sent no text)")
      ctx.stat("steps", String(result.steps)); ctx.stat("in", String(result.inputTokens)); ctx.stat("out", String(result.outputTokens))
      ctx.stat("time", `${((performance.now() - t0) / 1000).toFixed(1)}s`)
      window.dispatchEvent(new CustomEvent("learn:done"))
    } catch (error) {
      live.remove()
      const message = error instanceof Error ? error.message : String(error)
      const budget = Number(/exceeds the (\d+)-token context budget/.exec(message)?.[1])
      const lost = state.model
      if (Number.isFinite(budget)) explainBudget(budget)
      else if (lost?.choice.kind === "webllm" && /device was lost|mapAsync|GPUBuffer|Model not loaded before/i.test(message)) {
        // After a lost device every later request fails the same way: drop the engine and say what to do.
        await Promise.resolve(lost.dispose()).catch(() => undefined)
        await fallBackToEcho()
        chat.add("error", `The GPU stopped running ${lost.choice.label}: it ran out of memory or the driver reset the device. Echo is active again. Choose ${lost.choice.label} again to reload it. It needs about ${(lost.choice.memoryMB / 1000).toFixed(1)} GB of GPU memory, so on a GPU that shares memory with the system a smaller model is safer.`)
      } else chat.add("error", message)
    } finally {
      state.running = false
      refresh()
      chat.focus()
      void refreshInspector()
      if (rebuildQueued) { rebuildQueued = false; void rebuild() }
    }
  }

  // ── panes: maximise, focus ──────────────────────────────────────────────
  root.querySelectorAll<HTMLButtonElement>("[data-max]").forEach((button) => button.addEventListener("click", () => {
    const pane = button.closest<HTMLElement>("[data-pane]")?.dataset.pane
    if (!pane) return
    if (grid.dataset.max === pane) { delete grid.dataset.max; button.textContent = "⤢" } else { grid.dataset.max = pane; button.textContent = "⤡" }
  }))

  const ALL_SECTIONS: ReadonlyArray<Section> = ["imports", "session", "define"]
  type Focus = { pane?: string | undefined; file?: string | undefined; unfold?: string | undefined; view?: string | undefined; wide?: string | undefined }
  const applyFocus = (detail: Focus) => {
    ctx.showView(detail.view ?? "inspector")
    if (detail.wide === "true") grid.dataset.wide = "true"; else delete grid.dataset.wide
    if (detail.pane) { grid.dataset.focus = detail.pane; root.dataset.focus = detail.pane } else { delete grid.dataset.focus; delete root.dataset.focus }
    showFile(detail.file === "tiny" ? "tiny" : "agent")
    const open = new Set((detail.unfold ?? "").split(",").map((s) => s.trim()))
    if (detail.file !== "tiny") editor.foldOnly(ALL_SECTIONS.filter((section) => !open.has(section)))
  }
  window.addEventListener("learn:focus", (event) => applyFocus((event as CustomEvent<Focus>).detail))
  const active = document.querySelector<HTMLElement>("[data-step][data-active]")
  if (active) applyFocus({ pane: active.dataset.focus, file: active.dataset.file, unfold: active.dataset.unfold, view: active.dataset.view, wide: active.dataset.wide })

  // ── lesson controls (settings step) and experiments ─────────────────────
  const controlEls = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-control]")]
  function syncControls() {
    const values = readControls(editor.agentConfig())
    controlEls.forEach((control) => {
      const key = control.dataset.control as ControlKey
      const value = values[key]
      control.disabled = value === undefined
      if (value === undefined) return
      if (control instanceof HTMLInputElement && control.type === "checkbox") control.checked = Boolean(value)
      else if (document.activeElement !== control) control.value = String(value)
    })
    // The inspector's budget readout follows the code, not the other way round.
    if (values.budgetTokens !== undefined) document.querySelectorAll<HTMLElement>("[data-insp-budget]").forEach((out) => { out.textContent = String(values.budgetTokens) })
    document.querySelectorAll<HTMLElement>("[data-controls-note]").forEach((note) => { note.hidden = controlEls.every((control) => !control.disabled) })
  }
  let pending: ReturnType<typeof setTimeout> | undefined
  controlEls.forEach((control) => control.addEventListener("input", () => {
    const key = control.dataset.control as ControlKey
    const raw = control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked : key === "system" ? control.value : Number(control.value)
    if (typeof raw === "number" && !Number.isFinite(raw)) return
    const next = setField(editor.agentConfig(), key, raw)
    if (next === undefined) return
    editor.setAgentConfig(next)
    clearTimeout(pending)
    pending = setTimeout(() => void rebuild(), 400)
  }))

  const experiments: Record<string, () => string> = {
    pirate: () => setField(editor.agentConfig(), "system", "You are a pirate. Answer in at most two short sentences, and always say arr.") ?? editor.agentConfig(),
    "tiny-swap": () => editor.agentConfig().replace(/memoryWindowPlugin,|tinyMemory\(\d+\),/, "tinyMemory(2),"),
    "window-swap": () => editor.agentConfig().replace(/tinyMemory\(\d+\),/, "memoryWindowPlugin,"),
    "stream-off": () => setField(editor.agentConfig(), "streaming", false) ?? editor.agentConfig(),
    "break-memory": () => editor.agentConfig().replace(/\n\s*memoryWindowPlugin,[^\n]*/, ""),
    "tiny-budget": () => setField(editor.agentConfig(), "budgetTokens", 5) ?? editor.agentConfig(),
  }
  document.querySelectorAll<HTMLElement>("[data-exp]").forEach((button) => button.addEventListener("click", async () => {
    const make = experiments[button.dataset.exp!]
    if (!make) return
    editor.setAgentConfig(make())
    await rebuild()
    if (button.dataset.exp === "stream-off") chat.add("note", "Streaming is off: send a message and compare the events below.")
  }))

  // "Send 5 short messages": builds up a conversation to look at in the context pane.
  const FILL = ["tell me about topic 1", "tell me about topic 2", "tell me about topic 3", "tell me about topic 4", "tell me about topic 5"]
  document.querySelectorAll<HTMLButtonElement>("[data-fill]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true
    try {
      for (const text of FILL) { if (!state.built || !state.model) break; await send(text) }
    } finally { button.disabled = false }
  }))

  // ── start ───────────────────────────────────────────────────────────────
  // Echo and the agent come up at once; the device probe (a GPU lookup that can
  // be slow or hang) only decides how the other models are described.
  refresh()
  models.render(state.device)
  void probeDevice().then((device) => { state.device = device; models.render(device) })
  void (async () => {
    await ensureRuntime()
    await chooseModel(echoChoice)
    await rebuild()
    syncControls()
    refresh()
  })()
}
