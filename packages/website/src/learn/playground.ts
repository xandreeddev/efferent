// The playground: wires the panes (model bar, code, chat, context) to the
// lesson runtime, which runs the kernel in the page. What it runs, and what
// the controls and experiments change, comes from the lesson's definition.
import { Match, Option, Result } from "effect"
import { lessonOf } from "./lessons/index.ts"
import type { Lesson } from "./lesson.ts"
import { echoChoice } from "./models/mock.ts"
import { loadModel, probeDevice } from "./models/registry.ts"
import type { Device } from "./models/registry.ts"
import type { LoadedModel, ModelChoice } from "./models/types.ts"
import { mountChat } from "./panes/chat.ts"
import { mountContext } from "./panes/context.ts"
import { inspectorOf } from "./context-model.ts"
import { mountEditor } from "./panes/editor.ts"
import { mountInspector } from "./panes/inspector.ts"
import { mountModels, setModelName } from "./panes/models.ts"
import type { BuildResult, LessonEvent, LessonRuntime, Sent, SendOutcome } from "./runtime.ts"

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
  const keep = q<HTMLInputElement>("[data-keep]")

  const state = {
    runtime: undefined as LessonRuntime | undefined,
    runtimeReady: undefined as Promise<LessonRuntime> | undefined,
    model: undefined as LoadedModel | undefined,
    device: { gpu: { webgpu: false, f16: false, compatOnly: false }, chrome: { state: "unavailable", reason: "Checking…" } } as Device,
    built: false,
    loading: false,
    building: false,
  }
  const busy = () => state.runtime?.busy ?? false

  // ── panes ───────────────────────────────────────────────────────────────
  const ctx = mountContext(q('[data-pane="context"]'))
  const inspector = mountInspector(q('[data-view="inspector"]'))
  const models = mountModels(q(".wb-modelbar"), { choose: (choice) => void chooseModel(choice) })
  const editor = mountEditor(q("[data-editor]"), lesson.files, lesson.mainFile, { onRebuild: () => void rebuild(), onEdit: () => checkSyntaxSoon(), onFormat: () => void formatCode() })
  const chat = mountChat(q('[data-pane="chat"]'), {
    send: (text) => void send([text]),
    sendThree: () => void send(lesson.three),
    stop: () => void stop(),
    newChat: () => { if (!busy()) void newConversation() },
  })

  // ── status ──────────────────────────────────────────────────────────────
  const setChip = (text: string, kind: "idle" | "ready" | "error") => { chip.textContent = text; chip.dataset.state = kind }
  const refresh = () => {
    const ready = Boolean(state.runtime && state.model && state.built && !state.building)
    chat.setState({
      ready, running: busy(),
      hint: ready ? "" : state.model ? "Build the agent first (Rebuild in the Code pane)." : "Pick a model from the bar above.",
    })
    models.setBusy(state.loading || busy())
    if (state.loading) return setChip("loading model…", "idle")
    if (!state.runtime) return setChip("starting…", "idle")
    if (!state.model) return setChip("pick a model", "idle")
    if (state.building) return setChip("building…", "idle")
    if (!state.built) return setChip("agent not built", "error")
    setChip(busy() ? "answering" : "agent ready", "ready")
  }

  const ensureRuntime = (): Promise<LessonRuntime> => {
    state.runtimeReady ??= import("./runtime.ts").then(async ({ LessonRuntime }) => {
      const runtime = await LessonRuntime.create(lesson.evaluate)
      runtime.onEvent(heard)
      state.runtime = runtime
      return runtime
    })
    return state.runtimeReady
  }

  /** Read the journal back and redraw the context pane from it alone. */
  const refreshInspector = async () => {
    const runtime = state.runtime
    if (!runtime) return
    Result.match(inspectorOf(await runtime.journal()), {
      onFailure: (refused) => inspector.refused(refused.message),
      onSuccess: (model) => {
        inspector.update(model)
        Option.match(model.last, {
          onNone: () => {},
          onSome: (last) => {
            ctx.stat("steps", String(last.steps))
            ctx.stat("sent", String(last.sentTokens))
            ctx.stat("answered", String(last.answeredTokens))
          },
        })
      },
    })
  }

  // ── what the agent does, as the page hears it on Core ───────────────────
  /** The page's own messages: the bubble the inbox queued, and the answer its turn is writing. */
  const bubbles = new Map<number, { readonly user: HTMLElement; answer?: HTMLElement; text: string }>()
  /** The answer being written in each turn, by turn number. */
  const writing = new Map<number, number>()
  let t0 = 0

  /** The bubble of the page's message whose turn is writing in `turn`. */
  const writerOf = (turn: number) => Option.fromNullishOr(bubbles.get(writing.get(turn) ?? 0))

  function heard(event: LessonEvent) {
    ctx.event(event, t0)
    window.dispatchEvent(new CustomEvent("learn:event", { detail: event }))
    Match.value(event).pipe(
      Match.tag("Queued", (queued) => { bubbles.set(queued.id, { user: chat.queued(queued.ticket, queued.text), text: "" }) }),
      Match.tag("UserMessage", (message) => Option.match(Option.flatMap(message.id, (id) => Option.fromNullishOr(bubbles.get(id))), {
        onNone: () => {},
        onSome: (bubble) => {
          chat.started(bubble.user)
          bubble.answer = chat.add("agent", "")
          bubble.answer.dataset.live = ""
          writing.set(message.turn, Option.getOrElse(message.id, () => 0))
        },
      })),
      Match.tag("Delta", (delta) => Option.match(writerOf(delta.turn), {
        onNone: () => {},
        onSome: (bubble) => { bubble.text += delta.text; if (bubble.answer) chat.setReply(bubble.answer, bubble.text) },
      })),
      Match.tag("TurnEnded", (ended) => { writing.delete(ended.turn); void refreshInspector() }),
      Match.orElse(() => {}),
    )
  }

  /** How one message ended: its reply (the whole text, whatever pieces the page heard), or why it has none. */
  const settle = async (sent: Sent, outcome: SendOutcome) => {
    const bubble = bubbles.get(sent.id)
    bubbles.delete(sent.id)
    const answer = bubble?.answer
    answer?.removeAttribute("data-live")
    const dropEmpty = () => { if (answer && !bubble?.text) answer.remove() }
    await Match.valueTags(outcome, {
      Replied: (replied) => { if (answer) chat.setReply(answer, replied.text.length > 0 ? replied.text : "(the model sent no text)") },
      Stopped: () => {
        dropEmpty()
        if (answer) chat.add("note", "Stopped.")
        else if (bubble) {
          // Its turn never started: the message waited in the queue when the inbox closed.
          const badge = bubble.user.querySelector(".msg-queued")
          if (badge) badge.textContent = "stopped while queued"
        }
      },
      OverBudget: (over) => { dropEmpty(); explainBudget(over) },
      Refused: (refused) => { dropEmpty(); chat.add("error", refused.message) },
      Failed: async (failed) => {
        dropEmpty()
        const lost = state.model
        if (lost?.choice.kind === "webllm" && /device was lost|mapAsync|GPUBuffer|Model not loaded before/i.test(failed.message)) {
          // After a lost device every later request fails the same way: drop the engine and say what to do.
          await Promise.resolve(lost.dispose()).catch(() => undefined)
          await fallBackToEcho()
          chat.add("error", `The GPU stopped running ${lost.choice.label}: it ran out of memory or the driver reset the device. Echo is active again. Choose ${lost.choice.label} again to reload it. It needs about ${(lost.choice.memoryMB / 1000).toFixed(1)} GB of GPU memory, so on a GPU that shares memory with the system a smaller model is safer.`)
        } else chat.add("error", failed.message)
      },
    })
    if (!busy()) {
      ctx.stat("time", `${((performance.now() - t0) / 1000).toFixed(1)}s`)
      window.dispatchEvent(new CustomEvent("learn:done"))
      chat.focus()
    }
    refresh()
    void refreshInspector()
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
      // The model is part of the agent: the agent is built again over the same base, so the chat goes on.
      if (state.built) await rebuild()
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
  const showBuild = (result: BuildResult) => {
    buildBox.replaceChildren()
    if (result._tag === "Built") {
      buildBox.dataset.state = "ok"
      buildBox.textContent = keep.checked
        ? "Built: the agent runs over the base, and the conversation is kept."
        : "Built: the agent runs over the base, in a new conversation (Keep chat on rebuild is off)."
    } else {
      buildBox.dataset.state = "error"
      buildBox.textContent = `The agent did not build: ${result.message}`
    }
  }

  const rebuild = async (): Promise<boolean> => {
    const runtime = await ensureRuntime()
    if (runtime.busy) {
      buildBox.dataset.state = "idle"
      buildBox.textContent = "The agent is answering. It is built again once every queued message has its reply."
    }
    state.building = !runtime.busy
    refresh()
    const result = await runtime.rebuild(editor.sources())
    state.building = false
    state.built = result._tag === "Built"
    showBuild(result)
    if (state.built && !keep.checked) await newConversation(false)
    refresh()
    syncControls()
    return state.built
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
    lesson.files.forEach((file) => editor.setSource(file.id, file.defaultText))
    void rebuild()
  })

  let syntaxTimer: ReturnType<typeof setTimeout> | undefined
  const checkSyntaxSoon = () => {
    clearTimeout(syntaxTimer)
    syntaxTimer = setTimeout(() => {
      try {
        new Function(`return (${editor.source(editor.file())}\n)`)
        syntaxBox.textContent = ""
      } catch (error) {
        syntaxBox.textContent = error instanceof Error ? error.message : String(error)
      }
      syncControls()
    }, 350)
  }
  /** A file the lesson has, or its main file. */
  const fileOf = (id: string | undefined): string => lesson.files.find((file) => file.id === id)?.id ?? lesson.mainFile
  root.querySelectorAll<HTMLButtonElement>("[data-file]").forEach((tab) => tab.addEventListener("click", () => showFile(fileOf(tab.dataset.file))))
  const showFile = (file: string) => {
    editor.showFile(file)
    root.querySelectorAll<HTMLButtonElement>("[data-file]").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.file === file)))
    checkSyntaxSoon()
  }

  // ── chat ────────────────────────────────────────────────────────────────
  /** A new, empty session in the same base: the chat and the context panes start over. */
  const newConversation = async (announce = true) => {
    await state.runtime?.clear()
    bubbles.clear()
    writing.clear()
    chat.clear()
    ctx.resetTurn()
    inspector.clear()
    if (announce) refresh()
  }

  const send = async (texts: ReadonlyArray<string>) => {
    const runtime = state.runtime
    if (!runtime || !state.built || !state.model || state.building) return
    if (!runtime.busy) {
      ctx.resetTurn()
      t0 = performance.now()
      window.dispatchEvent(new CustomEvent("learn:start"))
    }
    const sent = await runtime.send(texts)
    refresh()
    sent.forEach((entry) => { void entry.outcome.then((outcome) => settle(entry, outcome)) })
  }

  /** Stop: the running turn ends Interrupted, queued messages are dropped, and the agent is built again. */
  const stop = async () => {
    const runtime = state.runtime
    if (!runtime) return
    state.building = true
    refresh()
    const result = await runtime.stop()
    state.building = false
    state.built = result._tag === "Built"
    showBuild(result)
    refresh()
  }

  /** Memory refused a request it cannot fit: say why from its own figures, and offer the way out. */
  const explainBudget = (outcome: Extract<SendOutcome, { _tag: "OverBudget" }>) => {
    const item = chat.add("error", `This request does not fit the ${outcome.budgetTokens}-token budget. Memory always sends the system text and the message this turn answers, and leaves out only older messages; those two alone come to about ${outcome.estimatedTokens} tokens. No request was sent. Your message stays in the journal, so once the budget is raised it goes with your next message: no need to send it again.`)
    const actions = document.createElement("div")
    actions.className = "msg-actions"
    Option.match(lesson.raisedBudget(outcome), {
      onNone: () => {},
      onSome: (raised) => {
        const raise = document.createElement("button")
        raise.type = "button"
        raise.className = "btn btn-quiet"
        raise.textContent = `Raise budget to ${raised}`
        raise.addEventListener("click", async () => {
          // Written into the code as it is when clicked; a budget line the learner removed is left alone.
          const next = Option.flatMap(Option.fromNullishOr(lesson.controls.budgetTokens), (control) => control.write(editor.source(lesson.mainFile), raised))
          if (Option.isNone(next)) return
          editor.setSource(lesson.mainFile, next.value)
          await rebuild()
          actions.remove()
        })
        actions.append(raise)
        item.append(actions)
      },
    })
  }

  // ── panes: maximise, focus ──────────────────────────────────────────────
  root.querySelectorAll<HTMLButtonElement>("[data-max]").forEach((button) => button.addEventListener("click", () => {
    const pane = button.closest<HTMLElement>("[data-pane]")?.dataset.pane
    if (!pane) return
    if (grid.dataset.max === pane) { delete grid.dataset.max; button.textContent = "⤢" } else { grid.dataset.max = pane; button.textContent = "⤡" }
  }))

  type Focus = { pane?: string | undefined; file?: string | undefined; unfold?: string | undefined; view?: string | undefined; wide?: string | undefined }
  const applyFocus = (detail: Focus) => {
    ctx.showView(detail.view ?? "inspector")
    if (detail.wide === "true") grid.dataset.wide = "true"; else delete grid.dataset.wide
    if (detail.pane) { grid.dataset.focus = detail.pane; root.dataset.focus = detail.pane } else { delete grid.dataset.focus; delete root.dataset.focus }
    const file = fileOf(detail.file)
    showFile(file)
    const open = new Set((detail.unfold ?? "").split(",").map((s) => s.trim()))
    const sections = lesson.files.find((entry) => entry.id === file)?.sections ?? []
    editor.foldOnly(sections.map((section) => section.id).filter((section) => !open.has(section)))
  }
  window.addEventListener("learn:focus", (event) => applyFocus((event as CustomEvent<Focus>).detail))
  const active = document.querySelector<HTMLElement>("[data-step][data-active]")
  if (active) applyFocus({ pane: active.dataset.focus, file: active.dataset.file, unfold: active.dataset.unfold, view: active.dataset.view, wide: active.dataset.wide })

  // ── lesson controls and experiments ─────────────────────────────────────
  const controlEls = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-control]")]
  const controlOf = (control: HTMLElement) => Option.fromNullishOr(lesson.controls[control.dataset.control ?? ""])
  const readControl = (key: string) => Option.flatMap(Option.fromNullishOr(lesson.controls[key]), (control) => control.read(editor.source(lesson.mainFile)))
  function syncControls() {
    controlEls.forEach((control) => {
      const value = readControl(control.dataset.control ?? "")
      control.disabled = Option.isNone(value)
      if (Option.isSome(value) && document.activeElement !== control) control.value = String(value.value)
    })
    // The inspector's budget readout follows the code, not the other way round.
    Option.match(readControl("budgetTokens"), {
      onNone: () => {},
      onSome: (budget) => document.querySelectorAll<HTMLElement>("[data-insp-budget]").forEach((out) => { out.textContent = String(budget) }),
    })
    document.querySelectorAll<HTMLElement>("[data-controls-note]").forEach((note) => { note.hidden = controlEls.every((control) => !control.disabled) })
  }
  let pending: ReturnType<typeof setTimeout> | undefined
  controlEls.forEach((control) => control.addEventListener("input", () => {
    const bound = controlOf(control)
    if (Option.isNone(bound)) return
    // A number field or a slider writes a number; text and a choice write text.
    const numeric = control instanceof HTMLInputElement && (control.type === "number" || control.type === "range")
    const raw = numeric ? Number(control.value) : control.value
    if (typeof raw === "number" && !Number.isFinite(raw)) return
    Option.match(bound.value.write(editor.source(lesson.mainFile), raw), {
      onNone: () => {},
      onSome: (next) => {
        editor.setSource(lesson.mainFile, next)
        clearTimeout(pending)
        pending = setTimeout(() => void rebuild(), 400)
      },
    })
  }))

  document.querySelectorAll<HTMLElement>("[data-exp]").forEach((button) => button.addEventListener("click", async () => {
    const make = lesson.experiments[button.dataset.exp ?? ""]
    if (!make) return
    const next = make(editor.source(lesson.mainFile))
    if (Option.isNone(next)) {
      buildBox.dataset.state = "error"
      buildBox.textContent = "This experiment could not find its line in your code. Press Reset in the Code pane to bring it back."
      return
    }
    editor.setSource(lesson.mainFile, next.value)
    await rebuild()
  }))

  // "Send 5 short messages": queued at once through the inbox, to build up a conversation to look at.
  document.querySelectorAll<HTMLButtonElement>("[data-fill]").forEach((button) => button.addEventListener("click", () => void send(lesson.fill)))

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
