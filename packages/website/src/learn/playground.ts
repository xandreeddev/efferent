// The playground: wires the panes (model bar, code and context, chat) to the
// lesson runtime, which runs the kernel in the page and the learner's
// program over it. What it runs, and what the controls and experiments
// change, comes from the lesson's definition.
import { Option } from "effect"
import { assistantMessageEvent, toolResultEvent, turnEndedEvent, userMessageEvent } from "@xandreed/core/kernel"
import { lessonOf } from "./lessons/index.ts"
import type { Lesson } from "./lesson.ts"
import { echoChoice } from "./models/mock.ts"
import { loadModel, probeDevice } from "./models/registry.ts"
import type { Device } from "./models/registry.ts"
import type { LoadedModel, ModelChoice } from "./models/types.ts"
import { mountChat } from "./panes/chat.ts"
import { mountEditor } from "./panes/editor.ts"
import { mountModels, setModelName } from "./panes/models.ts"
import { mountTrace } from "./panes/trace.ts"
import type { BuildResult, LessonRuntime, Trace } from "./runtime.ts"

const CONTEXT_TAB = "context"

const root = document.querySelector<HTMLElement>(".wb-bench")
if (root) {
  Option.match(lessonOf(root.dataset.lesson ?? ""), {
    onNone: () => { throw new Error(`the workbench has no lesson named ${JSON.stringify(root.dataset.lesson)}`) },
    onSome: (lesson) => boot(root, lesson),
  })
}

function boot(root: HTMLElement, lesson: Lesson) {
  const q = <T extends HTMLElement>(selector: string): T => {
    const found = root.querySelector<T>(selector)
    if (!found) throw new Error(`playground markup is missing ${selector}`)
    return found
  }
  const grid = q("[data-grid]")
  const chip = q("[data-chip]")
  const buildBox = q("[data-build]")
  const syntaxBox = q("[data-syntax]")
  const statusBox = q("[data-status]")
  const editorHost = q("[data-editor]")
  const traceHost = q("[data-trace]")
  const contextTab = q<HTMLButtonElement>(`[data-file="${CONTEXT_TAB}"]`)
  const rebuildButton = q<HTMLButtonElement>("[data-rebuild]")
  const formatButton = q<HTMLButtonElement>("[data-format]")
  const resetButton = q<HTMLButtonElement>("[data-reset-code]")

  const state = {
    runtime: undefined as LessonRuntime | undefined,
    runtimeReady: undefined as Promise<LessonRuntime> | undefined,
    model: undefined as LoadedModel | undefined,
    device: { gpu: { webgpu: false, f16: false, compatOnly: false }, chrome: { state: "unavailable", reason: "Checking…" } } as Device,
    /** The program is running and taking messages. */
    alive: false,
    loading: false,
    building: false,
    builds: 0,
  }
  const busy = () => state.runtime?.busy ?? false

  // ── panes ───────────────────────────────────────────────────────────────
  const trace = mountTrace(traceHost)
  const models = mountModels(q(".wb-modelbar"), { choose: (choice) => void chooseModel(choice) })
  const editor = mountEditor(editorHost, lesson.files, lesson.mainFile, { onRebuild: () => void rebuild(), onEdit: () => checkSyntaxSoon(), onFormat: () => void formatCode() })
  const chat = mountChat(q('[data-pane="chat"]'), {
    send: (text) => send([text]),
    sendThree: () => send(lesson.three),
    stop: () => void stop(),
    newChat: () => void newConversation(),
  })

  // ── status ──────────────────────────────────────────────────────────────
  const setChip = (text: string, kind: "idle" | "ready" | "error") => { chip.textContent = text; chip.dataset.state = kind }
  const refresh = () => {
    const ready = Boolean(state.runtime && state.model && state.alive && !state.building)
    chat.setState({
      ready, running: busy() || waiting.length > 0,
      hint: ready ? "" : !state.model ? "Pick a model from the bar above." : state.building ? "Starting your program…" : "Your program is not running. Fix it, then press Rebuild.",
    })
    models.setBusy(state.loading || busy())
    if (state.loading) return setChip("loading model…", "idle")
    if (!state.runtime) return setChip("starting…", "idle")
    if (!state.model) return setChip("pick a model", "idle")
    if (state.building) return setChip("building…", "idle")
    if (!state.alive) return setChip("program stopped", "error")
    setChip(busy() ? "answering" : "waiting for a message", "ready")
  }

  const ensureRuntime = (): Promise<LessonRuntime> => {
    state.runtimeReady ??= import("./runtime.ts").then(async ({ LessonRuntime }) => {
      const runtime = await LessonRuntime.create(lesson)
      trace.reset(runtime.conversation)
      runtime.onTrace(heard)
      state.runtime = runtime
      return runtime
    })
    return state.runtimeReady
  }

  // ── what the program does, as the page hears it ─────────────────────────
  /** Messages sent and not yet taken by a turn, oldest first. */
  const waiting: Array<HTMLElement> = []
  /** The tool calls the model made, by id, as the chat shows them. */
  const calls = new Map<string, string>()
  /** The answer being written, by turn. */
  const answers = new Map<number, { readonly item: HTMLElement; text: string }>()
  let unseen = false

  const answerOf = (turn: number) => {
    const found = answers.get(turn)
    if (found !== undefined) return found
    const item = chat.add("agent", "")
    item.dataset.live = ""
    const made = { item, text: "" }
    answers.set(turn, made)
    return made
  }
  const finish = (turn: number) => {
    const found = answers.get(turn)
    found?.item.removeAttribute("data-live")
    if (found !== undefined && found.text.length === 0) found.item.remove()
    answers.delete(turn)
  }

  function heard(event: Trace) {
    trace.hear(event)
    if (contextTab.getAttribute("aria-selected") !== "true" && !unseen) { unseen = true; contextTab.dataset.unseen = "" }
    window.dispatchEvent(new CustomEvent("learn:trace", { detail: event }))
    switch (event._tag) {
      case "Event": {
        const record = event.event
        if (record._tag !== "Stored" || state.runtime === undefined || record.session !== state.runtime.conversation) break
        if (record.name === userMessageEvent.name) {
          // The program took the oldest waiting message: its turn has it now.
          const item = waiting.shift()
          if (item !== undefined) chat.started(item)
          answerOf(record.turn)
        }
        if (record.name === turnEndedEvent.name) {
          const outcome = (record.data as { readonly outcome?: { readonly _tag?: string } }).outcome?._tag
          if (outcome === "Interrupted") {
            const answer = answers.get(record.turn)
            if (answer !== undefined && answer.text.length > 0) answer.text += "\n\n*(stopped)*"
            if (answer !== undefined) chat.setReply(answer.item, answer.text)
            chat.add("note", `Turn ${record.turn} was stopped. Your message stays in the journal.`)
            finish(record.turn)
          }
          window.dispatchEvent(new CustomEvent("learn:done"))
        }
        if (record.name === assistantMessageEvent.name && record.message?._tag === "Assistant" && record.message.toolCalls.length > 0) {
          // The model asked for tools: this call's answer is done, and the next call streams into a bubble of its own.
          record.message.toolCalls.forEach((call) => calls.set(call.id, `${call.name}(${JSON.stringify(call.input)})`))
          finish(record.turn)
        }
        if (record.name === toolResultEvent.name && record.message?._tag === "ToolResult") {
          const { id, isFailure, result } = record.message
          const shown = chat.add("tool", `${calls.get(id) ?? record.message.name} ${isFailure ? "failed:" : "→"} ${JSON.stringify(result)}`)
          if (isFailure) shown.dataset.failed = ""
        }
        if (record.name === assistantMessageEvent.name) refresh()
        break
      }
      case "Piece": {
        const answer = answerOf(event.turn)
        answer.text += event.text
        chat.setReply(answer.item, answer.text)
        break
      }
      case "Reply": {
        const answer = answerOf(event.turn)
        answer.text = event.text.length > 0 ? event.text : "(the model sent no text)"
        chat.setReply(answer.item, answer.text)
        finish(event.turn)
        chat.focus()
        break
      }
      case "Failed": {
        finish(event.turn)
        void failed(event.message)
        break
      }
      case "Status":
        statusBox.textContent = event.text
        break
      case "Ended": {
        state.alive = false
        answers.forEach((_answer, turn) => finish(turn))
        waiting.splice(0).forEach((item) => chat.dropped(item, "not taken: the program stopped"))
        chat.add("error", `${event.reason[0]?.toUpperCase() ?? ""}${event.reason.slice(1)} Fix your code, then press Rebuild.`)
        showFoot("error", `Build ${state.builds}: ${event.reason}`)
        break
      }
      default:
        break
    }
    refresh()
  }

  /** A turn failed: the program said why. A lost GPU is said in words, and Echo takes over. */
  const failed = async (message: string) => {
    const lost = state.model
    if (lost?.choice.kind === "webllm" && /device was lost|mapAsync|GPUBuffer|Model not loaded before/i.test(message)) {
      await Promise.resolve(lost.dispose()).catch(() => undefined)
      await fallBackToEcho()
      chat.add("error", `The GPU stopped running ${lost.choice.label}: it ran out of memory or the driver reset the device. Echo is active again. Choose ${lost.choice.label} again to reload it. It needs about ${(lost.choice.memoryMB / 1000).toFixed(1)} GB of GPU memory, so on a GPU that shares memory with the system a smaller model is safer.`)
    } else chat.add("error", message)
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
    await rebuild()
  }

  const chooseModel = async (choice: ModelChoice) => {
    if (state.loading || busy()) return
    state.loading = true
    refresh()
    models.note(choice.id, "")
    // The list closes so the progress bar under the model's name shows (on a phone the list covers it).
    if (choice.id !== echoChoice.id) models.close()
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
      // The model is one of the program's modules: the program runs again with it, over the same conversation.
      if (state.builds > 0) await rebuild()
      if (chat.hasMessages()) chat.add("note", `Model: ${choice.label}`)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const noGpu = /compatible GPU|WebGPU|adapter/i.test(reason)
      models.fail(choice.id, noGpu
        ? "This device has no usable GPU for WebGPU, so this model cannot run here. See how to enable it below, or use a CPU model."
        : `Could not load: ${reason}`)
      models.open()
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
  /** Say what happened in the foot, and flash it, so the same message twice is still seen. */
  const showFoot = (kind: "ok" | "error" | "idle", text: string) => {
    buildBox.dataset.state = kind
    buildBox.textContent = text
    buildBox.classList.remove("flash")
    void buildBox.offsetWidth
    buildBox.classList.add("flash")
  }

  const showBuild = (result: BuildResult, what: string) => {
    if (result._tag === "Built") {
      state.alive = true
      showFoot("ok", `Build ${state.builds}: ${what} Your program is running, and waiting for messages.`)
    } else {
      state.alive = false
      showFoot("error", `Build ${state.builds}: your program did not start. ${result.message}`)
    }
  }

  /** Run the code again: the program running is stopped (a turn in progress ends Interrupted), and started over the same conversation. */
  const rebuild = async (what = "your code runs."): Promise<boolean> => {
    const runtime = await ensureRuntime()
    state.building = true
    state.builds++
    rebuildButton.disabled = true
    rebuildButton.textContent = "Building…"
    refresh()
    // Counted before the program starts again, which takes the first of them at once.
    const kept = waiting.length
    try {
      // A build takes a few milliseconds; "Building…" stays long enough to be seen.
      const [result] = await Promise.all([runtime.start(editor.sources()), new Promise((resolve) => setTimeout(resolve, 400))])
      showBuild(result, kept > 0 ? `${what} ${kept} waiting message${kept === 1 ? " is" : "s are"} kept.` : what)
      return result._tag === "Built"
    } finally {
      state.building = false
      rebuildButton.disabled = false
      rebuildButton.textContent = "Rebuild"
      refresh()
      syncControls()
    }
  }
  rebuildButton.addEventListener("click", () => void rebuild())

  const formatCode = async () => {
    if (!traceHost.hidden) return
    formatButton.disabled = true
    formatButton.textContent = "Formatting…"
    const before = editor.source(editor.file())
    const result = await editor.format()
    formatButton.disabled = false
    // The edit re-runs the syntax check; a failure says why it could not be formatted.
    if (!result.ok) {
      syntaxBox.textContent = result.message
      formatButton.textContent = "Can't format"
    } else formatButton.textContent = editor.source(editor.file()) === before ? "Already tidy" : "Formatted ✓"
    setTimeout(() => { formatButton.textContent = "Format" }, 1500)
  }
  formatButton.addEventListener("click", () => void formatCode())
  resetButton.addEventListener("click", () => {
    lesson.files.forEach((file) => { if (!file.readOnly) editor.setSource(file.id, file.defaultText) })
    void rebuild("the starter code is back in every file, and runs.")
  })

  let syntaxTimer: ReturnType<typeof setTimeout> | undefined
  const checkSyntaxSoon = () => {
    clearTimeout(syntaxTimer)
    syntaxTimer = setTimeout(() => {
      const file = lesson.files.find((entry) => entry.id === editor.file())
      if (file === undefined || file.readOnly) { syntaxBox.textContent = ""; return }
      const source = editor.source(file.id)
      try {
        // A file of statements parses as a function's body; one that is an expression, as its return value.
        if (file.formatPrefix === "") new Function(source)
        else new Function(`return (${source}\n)`)
        syntaxBox.textContent = ""
      } catch (error) {
        syntaxBox.textContent = error instanceof Error ? error.message : String(error)
      }
      syncControls()
    }, 350)
  }

  /** A file the lesson has, the Context tab, or the main file. */
  const tabOf = (id: string | undefined): string => id === CONTEXT_TAB ? CONTEXT_TAB : lesson.files.find((file) => file.id === id)?.id ?? lesson.mainFile
  root.querySelectorAll<HTMLButtonElement>("[data-file]").forEach((tab) => tab.addEventListener("click", () => showTab(tabOf(tab.dataset.file))))
  const showTab = (tab: string) => {
    const context = tab === CONTEXT_TAB
    editorHost.hidden = context
    traceHost.hidden = !context
    formatButton.hidden = context
    syntaxBox.hidden = context
    if (context) { unseen = false; delete contextTab.dataset.unseen } else editor.showFile(tab)
    const readOnly = lesson.files.find((file) => file.id === tab)?.readOnly === true
    formatButton.disabled = readOnly
    root.querySelectorAll<HTMLButtonElement>("[data-file]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.file === tab)))
    if (!context) checkSyntaxSoon()
  }

  // ── chat ────────────────────────────────────────────────────────────────
  /** A new, empty conversation in the same base: the chat and the Context tab start over. */
  const newConversation = async () => {
    const runtime = await ensureRuntime()
    state.building = true
    state.builds++
    refresh()
    // The program is stopped first, so nothing it was still saying lands in the new conversation's chat.
    const result = await runtime.clear()
    waiting.splice(0)
    answers.clear()
    chat.clear()
    statusBox.textContent = ""
    trace.reset(runtime.conversation)
    state.building = false
    showBuild(result, "a new, empty conversation; the old one stays in the journal store.")
    refresh()
  }

  const send = (texts: ReadonlyArray<string>) => {
    const runtime = state.runtime
    if (!runtime || !state.alive || !state.model || state.building) return
    if (!busy() && waiting.length === 0) window.dispatchEvent(new CustomEvent("learn:start"))
    texts.forEach((text) => {
      waiting.push(chat.waiting(text))
      runtime.send(text)
    })
    refresh()
  }

  /** Stop: the waiting messages are dropped, the model is told to stop, and the program runs again. */
  const stop = async () => {
    const runtime = state.runtime
    if (!runtime) return
    state.building = true
    state.builds++
    refresh()
    const { dropped, result } = await runtime.stop()
    waiting.splice(0).forEach((item) => chat.dropped(item, "dropped by Stop"))
    state.building = false
    showBuild(result, dropped.length > 0 ? `stopped; ${dropped.length} waiting message${dropped.length === 1 ? " was" : "s were"} dropped.` : "stopped.")
    refresh()
  }

  // ── panes: maximise, focus ──────────────────────────────────────────────
  root.querySelectorAll<HTMLButtonElement>("[data-max]").forEach((button) => button.addEventListener("click", () => {
    const pane = button.closest<HTMLElement>("[data-pane]")?.dataset.pane
    if (!pane) return
    if (grid.dataset.max === pane) { delete grid.dataset.max; button.textContent = "⤢" } else { grid.dataset.max = pane; button.textContent = "⤡" }
  }))

  type Focus = { pane?: string | undefined; file?: string | undefined; unfold?: string | undefined; wide?: string | undefined }
  const applyFocus = (detail: Focus) => {
    // A step about the context opens the Context tab in the Code pane.
    const context = detail.pane === "context" || detail.file === CONTEXT_TAB
    const pane = context ? "code" : detail.pane
    if (detail.wide === "true" || context) grid.dataset.wide = "true"; else delete grid.dataset.wide
    if (pane) { grid.dataset.focus = pane; root.dataset.focus = detail.pane ?? pane } else { delete grid.dataset.focus; delete root.dataset.focus }
    const file = tabOf(detail.file)
    if (file !== CONTEXT_TAB) {
      showTab(file)
      const open = new Set((detail.unfold ?? "").split(",").map((s) => s.trim()))
      const folded = lesson.files.find((entry) => entry.id === file)?.folded ?? []
      editor.foldOnly(folded.filter((section) => !open.has(section)))
    }
    if (context) showTab(CONTEXT_TAB)
  }
  window.addEventListener("learn:focus", (event) => applyFocus((event as CustomEvent<Focus>).detail))
  const active = document.querySelector<HTMLElement>("[data-step][data-active]")
  applyFocus(active ? { pane: active.dataset.focus, file: active.dataset.file, unfold: active.dataset.unfold, wide: active.dataset.wide } : {})

  // ── lesson controls and experiments ─────────────────────────────────────
  const controlEls = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-control]")]
  const controlOf = (key: string) => Option.fromNullishOr(lesson.controls[key])
  const readControl = (key: string) => Option.flatMap(controlOf(key), (control) => control.read(editor.source(control.file)))
  function syncControls() {
    controlEls.forEach((control) => {
      const value = readControl(control.dataset.control ?? "")
      control.disabled = Option.isNone(value)
      if (Option.isSome(value) && document.activeElement !== control) control.value = String(value.value)
    })
    document.querySelectorAll<HTMLElement>("[data-controls-note]").forEach((note) => { note.hidden = controlEls.every((control) => !control.disabled) })
  }
  let pending: ReturnType<typeof setTimeout> | undefined
  controlEls.forEach((control) => control.addEventListener("input", () => {
    const bound = controlOf(control.dataset.control ?? "")
    if (Option.isNone(bound)) return
    // A number field or a slider writes a number; text and a choice write text.
    const numeric = control instanceof HTMLInputElement && (control.type === "number" || control.type === "range")
    const raw = numeric ? Number(control.value) : control.value
    if (typeof raw === "number" && !Number.isFinite(raw)) return
    Option.match(bound.value.write(editor.source(bound.value.file), raw), {
      onNone: () => {},
      onSome: (next) => {
        editor.setSource(bound.value.file, next)
        clearTimeout(pending)
        pending = setTimeout(() => void rebuild(`${lesson.files.find((file) => file.id === bound.value.file)?.label ?? "the code"} changed, and runs.`), 400)
      },
    })
  }))

  document.querySelectorAll<HTMLButtonElement>("[data-exp]").forEach((button) => button.addEventListener("click", async () => {
    const experiment = lesson.experiments[button.dataset.exp ?? ""]
    if (!experiment) return
    const label = lesson.files.find((file) => file.id === experiment.file)?.label ?? experiment.file
    const next = experiment.apply(editor.source(experiment.file))
    if (Option.isNone(next)) {
      showFoot("error", `This experiment could not find its line in ${label}. Press Reset in the Code pane to bring it back.`)
      return
    }
    editor.setSource(experiment.file, next.value)
    showTab(experiment.file)
    const original = button.textContent
    button.disabled = true
    button.textContent = "Applied ✓"
    await rebuild(`${label} changed by "${original?.trim()}", and runs.`)
    setTimeout(() => { button.disabled = false; button.textContent = original }, 1500)
  }))

  // "Send 5 short messages": sent at once, to build up a conversation to look at.
  document.querySelectorAll<HTMLButtonElement>("[data-fill]").forEach((button) => button.addEventListener("click", () => send(lesson.fill)))

  // ── start ───────────────────────────────────────────────────────────────
  // Echo and the program come up at once; the device probe (a GPU lookup that can
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
