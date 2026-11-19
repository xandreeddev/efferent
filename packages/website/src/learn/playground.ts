// The playground: wires the panes (model bar, code and context, chat) to the
// lesson runtime, which runs the kernel in the page and the learner's
// program over it. What it runs, and what the controls and experiments
// change, comes from the lesson's definition. A lesson with a workspace
// (lesson 16) has a Files tab too, over the page's own files, and a lesson
// with a graph (lesson 18) a Graph tab, over what each request's walk did.
import { Option, Result } from "effect"
import { dataOf, turnEndedEvent, turnStartedEvent } from "@xandreed/core/kernel"
import type { StoredEvent, TurnNumber } from "@xandreed/core/kernel"
import { attemptEvent, knowledgeOf, progressEvent, viewEvent } from "@xandreed/sdk/kernel"
import { attemptLine, branchPoints, drawsAnew, dropWaiting, emptyChat, hear, questionsWaiting, said, sent, stored, WAITING_FOR_ANSWER, waitingCount, withoutFailure } from "./chat-model.ts"
import { ignoredLine } from "./chats.ts"
import type { KeyValueStore } from "@xandreed/sdk/kernel"
import type { ChatBoard } from "./chat-model.ts"
import { lessonOf } from "./lessons/index.ts"
import { heardTask, noTasks } from "./task-chips.ts"
import type { TaskChips } from "./task-chips.ts"
import { applyExperiment, kitLine } from "./lesson.ts"
import type { Lesson } from "./lesson.ts"
import { echoChoice } from "./models/mock.ts"
import { cpuModel, gpuLostWords } from "./models/gpu-lost.ts"
import { catalogue, loadModel, probeDevice } from "./models/registry.ts"
import type { Device } from "./models/registry.ts"
import type { LoadedModel, ModelChoice } from "./models/types.ts"
import { mountChat } from "./panes/chat.ts"
import { mountEditor } from "./panes/editor.ts"
import { mountEvals } from "./panes/evals.ts"
import type { EvalsPane } from "./panes/evals.ts"
import { mountGraders } from "./panes/graders.ts"
import type { GradersPane } from "./panes/graders.ts"
import { mountFiles } from "./panes/files.ts"
import { LATEST, mountGraph } from "./panes/graph.ts"
import { curationCutLine, emptyRecalls, heardRecall, latestCuration, memoryViewOf, namedBy, NO_RECALL, NOTHING_KEPT, pickedRecall, recallLabel, recallsStartedOver, recallViewOf } from "./graph-model.ts"
import type { CurationView, MemoryView, RecallBoard, RecallPick, RecallView, Showing } from "./graph-model.ts"
import { mountModels, setModelName } from "./panes/models.ts"
import { mountTrace } from "./panes/trace.ts"
import type { BuildResult, LessonRuntime, Trace } from "./runtime.ts"
import { viewBoard } from "./views.ts"
import { workspaceLine, WorkspacePane } from "./workspace-pane.ts"

const CONTEXT_TAB = "context"
/** The Files tab of a lesson with a workspace (lesson 16). */
const FILES_TAB = "files"
/** The Graph tab of a lesson with a graph (lesson 18). */
const GRAPH_TAB = "graph"

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
  /** The Files tab's body: only a lesson with a workspace has one. */
  const filesHost = root.querySelector<HTMLElement>("[data-files]")
  /** The Graph tab's body: only a lesson with a graph has one. */
  const graphHost = root.querySelector<HTMLElement>("[data-graph]")
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
  /** A kit that runs alone is running (lesson 12's checks): the chat takes no message, and no model is changed, until it is done. */
  const checking = () => state.runtime?.checking ?? false
  /** The program's curator is keeping a turn (lesson 18): Stop cuts it, and what takes turns with the chat waits. */
  const curating = () => state.runtime?.curating ?? false
  /** The buttons of the kits that run alone: off while a turn runs or a message waits for one, while a model loads, and while such a kit runs. */
  const aloneButtons = [
    ...[...document.querySelectorAll<HTMLButtonElement>("[data-kit]")].filter((button) => lesson.kits?.[button.dataset.kit ?? ""]?.alone === true),
    // Lesson 13's "Run evals" takes turns with the chat too, and so do lesson 19's "Check the graders" and lesson 18's
    // "Load the world".
    ...document.querySelectorAll<HTMLButtonElement>('[data-evals="run"]'),
    ...document.querySelectorAll<HTMLButtonElement>("[data-world]"),
    ...document.querySelectorAll<HTMLButtonElement>('[data-graders="run"]'),
  ]

  // ── panes ───────────────────────────────────────────────────────────────
  const trace = mountTrace(traceHost)
  const models = mountModels(q(".wb-modelbar"), { choose: (choice) => void chooseModel(choice) })
  const editor = mountEditor(editorHost, lesson.files, lesson.mainFile, { onRebuild: () => void rebuild(), onEdit: () => checkSyntaxSoon(), onFormat: () => void formatCode() })
  const chat = mountChat(q('[data-pane="chat"]'), {
    send: (text) => send([text]),
    sendThree: () => send(lesson.three),
    stop: () => void stop(),
    newChat: () => void newConversation(),
    // A press on a question's button answers it: the tool that asked goes on, or is refused.
    decide: (id, decision) => state.runtime?.decide(id, decision),
    // Lesson 15: "Branch after turn N" makes a branch and switches nothing; a chat of the row is shown.
    branch: (turn) => void branchAfter(turn),
    choose: (id) => void chooseChat(id),
  })

  // Lesson 16: the Files tab, over the page's workspace once the runtime has built it. It reads the page's own files.
  let workspacePane: WorkspacePane | undefined
  const filesPane = filesHost === null ? undefined : mountFiles(filesHost, {
    choose: (path) => void workspacePane?.choose(path),
    edit: (draft) => workspacePane?.edit(draft),
    save: () => void workspacePane?.save(),
  })

  // Lesson 18: the Graph tab, drawn from the knowledge session's records and the recalls the page heard
  // (graph-model.ts): the memory always, and the latest curation and the recall picked (the latest unless one is
  // picked) lit on top. The views are worked out again only when what they are drawn from changes.
  let recalls: RecallBoard = emptyRecalls("")
  let recallPick: RecallPick = { _tag: "Latest" }
  let showing: Showing = "named"
  let graphCache: { readonly key: string; readonly memory: Option.Option<MemoryView>; readonly curation: Option.Option<CurationView>; readonly recall: Option.Option<RecallView> } | undefined
  const graphViews = () => {
    const heard = pickedRecall(recalls, recallPick)
    const key = [recalls.chat, recalls.records.length, recalls.recalls.length, showing, Option.match(heard, { onNone: () => "", onSome: (one) => `${one.turn}:${one.call}` })].join("|")
    if (graphCache?.key === key) return graphCache
    const knowledge = knowledgeOf(recalls.records)
    const curation = latestCuration(recalls.records)
    const recalled = Option.map(heard, (one) => one.recalled)
    const memory = knowledge.memories.length === 0 ? Option.none()
      : Option.some(memoryViewOf(recalls.records, showing, namedBy(knowledge, recalls.chat, recalls.recalls), recalled, curation))
    graphCache = { key, memory, curation, recall: Option.map(recalled, (one) => recallViewOf(one, recalls.records)) }
    return graphCache
  }
  const graphPane = graphHost === null ? undefined : mountGraph(graphHost, {
    pick: (value) => {
      const [turn, call] = value.split(":").map(Number)
      recallPick = value === LATEST || turn === undefined || call === undefined ? { _tag: "Latest" } : { _tag: "Call", turn, call }
      paintGraph()
    },
    everything: (on) => {
      showing = on ? "everything" : "named"
      paintGraph()
    },
  })
  let graphFrame = 0
  function paintGraph() {
    graphFrame = 0
    if (graphPane === undefined || graphHost === null || graphHost.hidden) return
    const views = graphViews()
    graphPane.render({
      memory: views.memory,
      empty: NOTHING_KEPT,
      everything: showing === "everything",
      curation: views.curation,
      choices: recalls.recalls.map((one) => ({ value: `${one.turn}:${one.call}`, label: recallLabel(recalls, one) })),
      picked: recallPick._tag === "Latest" ? LATEST : `${recallPick.turn}:${recallPick.call}`,
      // The recall drawn is named whichever way it was picked: "the latest request" alone says no turn.
      shown: Option.match(pickedRecall(recalls, recallPick), { onNone: () => "", onSome: (one) => recallLabel(recalls, one) }),
      recall: views.recall,
      noRecall: NO_RECALL,
    })
  }
  const paintGraphSoon = () => { if (graphFrame === 0) graphFrame = requestAnimationFrame(paintGraph) }
  /** A new conversation: its recalls start over, and the knowledge session's records stay. */
  const graphStartedOver = (chat: string) => {
    recalls = recallsStartedOver(recalls, chat)
    recallPick = { _tag: "Latest" }
    paintGraphSoon()
  }

  // ── status ──────────────────────────────────────────────────────────────
  // Called after every trace the page hears: a chip already showing this is left alone.
  const setChip = (text: string, kind: "idle" | "ready" | "error") => {
    if (chip.textContent !== text) chip.textContent = text
    if (chip.dataset.state !== kind) chip.dataset.state = kind
  }
  const refresh = () => {
    const ready = Boolean(state.runtime && state.model && state.alive && !state.building && !checking())
    chat.setState({
      ready, running: busy() || curating() || waitingCount(board) > 0,
      hint: ready ? "" : !state.model ? "Pick a model from the bar above." : state.building ? "Starting your program…"
        : checking() ? `${lesson.evals !== undefined ? "The evals are running" : lesson.calibration !== undefined ? "The graders are being checked" : lesson.graph !== undefined ? "The world is being loaded" : "The checks are running"}. The chat takes messages again when that is done.` : "Your program is not running. Fix it, then press Rebuild.",
    })
    models.setBusy(state.loading || busy() || curating() || checking())
    // A kit that runs alone and the chat take turns: its button is off while a turn runs or a message waits for one.
    // It is off while a model loads too: the load lets go of the model a check would run on.
    const aloneOff = checking() || state.loading || busy() || curating() || waitingCount(board) > 0
    aloneButtons.forEach((button) => { if (button.disabled !== aloneOff) button.disabled = aloneOff })
    if (state.loading) return setChip("loading model…", "idle")
    if (!state.runtime) return setChip("starting…", "idle")
    if (!state.model) return setChip("pick a model", "idle")
    if (state.building) return setChip("building…", "idle")
    if (!state.alive) return setChip("program stopped", "error")
    // A tool asked before it acts: the turn is open, and waits for the person, not for the model.
    if (questionsWaiting(board) > 0) return setChip(WAITING_FOR_ANSWER, "ready")
    setChip(busy() ? "answering" : "waiting for a message", "ready")
  }

  /** The tab's own storage (`sessionStorage`), where a durable lesson keeps the chat picked (lesson 15); none where the browser gives none. */
  const tabStorage = (): KeyValueStore | undefined => {
    try {
      const storage = window.sessionStorage
      storage.getItem("efferent-learn:probe")
      return storage
    } catch {
      return undefined
    }
  }
  /**
   * The browser's storage for a durable lesson; a storage of the page's own where the browser gives none (a
   * private window with storage blocked), with a line that says the conversation will not outlive the page.
   */
  const browserStorage = (): KeyValueStore | undefined => {
    try {
      const storage = window.localStorage
      storage.getItem("efferent-learn:probe")
      return storage
    } catch {
      showFoot("error", "This browser gives the page no storage (a private window, or storage blocked): the conversation is kept in the page, and is gone with it.")
      return undefined
    }
  }
  /** Where a durable lesson keeps the learner's edits across a reload, in this tab only. */
  const sourcesKey = lesson.durable === undefined ? undefined : `${lesson.durable.prefix}sources`
  const saveSources = () => {
    if (sourcesKey === undefined) return
    try { window.sessionStorage.setItem(sourcesKey, JSON.stringify(editor.sources())) } catch { /* no storage: the edits last as long as the page */ }
  }
  /** The edits the page before this one saved: an experiment applied before a reload is still applied after it. */
  const restoreSources = () => {
    if (sourcesKey === undefined) return
    try {
      const saved: unknown = JSON.parse(window.sessionStorage.getItem(sourcesKey) ?? "null")
      if (typeof saved !== "object" || saved === null) return
      lesson.files.forEach((file) => {
        const text = (saved as Record<string, unknown>)[file.id]
        if (!file.readOnly && typeof text === "string" && text !== editor.source(file.id)) editor.setSource(file.id, text)
      })
    } catch { /* no storage, or nothing readable saved: the starter code stands */ }
  }

  const ensureRuntime = (): Promise<LessonRuntime> => {
    state.runtimeReady ??= import("./runtime.ts").then(async ({ LessonRuntime }) => {
      const storage = lesson.durable === undefined ? undefined : browserStorage()
      const tab = lesson.durable === undefined ? undefined : tabStorage()
      const runtime = await LessonRuntime.create(lesson, { ...(storage === undefined ? {} : { storage }), ...(tab === undefined ? {} : { tab }) })
      trace.reset(runtime.conversation)
      graphStartedOver(runtime.conversation)
      runtime.onTrace(heard)
      state.runtime = runtime
      Option.map(runtime.workspace, (files) => {
        if (filesPane === undefined) return
        workspacePane = new WorkspacePane(files, filesPane.render)
        void workspacePane.refresh()
      })
      return runtime
    })
    return state.runtimeReady
  }

  // ── what the program does, as the page hears it ─────────────────────────
  /** The chat's rows: what was stored, and what was only said (chat-model.ts). Every change is drawn at once. */
  let board: ChatBoard = emptyChat
  const show = (next: ChatBoard) => {
    if (next === board) return
    board = next
    // Lesson 15: the last row of each closed turn carries "Branch after turn N".
    chat.render(board.rows, lesson.branch === undefined ? undefined : branchPoints(board))
  }
  /** Lesson 17: the chips of the background tasks the conversation shown started (task-chips.ts). */
  let taskChips: TaskChips = noTasks
  const showTasks = (next: TaskChips) => {
    if (next === taskChips) return
    taskChips = next
    chat.renderTasks(taskChips.chips)
  }
  let unseen = false
  /** The chat session's records as they are announced, for the views the chat draws (lesson 6). */
  const chatRecords: Array<StoredEvent> = []
  const views = viewBoard(() => chat.add("view", ""))

  /** The conversation a durable lesson's program last named. */
  let shownSession: string | undefined
  /** The program's own status line while a plan's attempts are said over it (lesson 14): put back when the turn ends. */
  let programStatus: string | undefined
  /**
   * The program's own status line while a workspace line is said over it (lesson 16): a write, or a write that failed.
   * Put back when the next turn starts, so the line speaks of the turn that is running or just ended, never an older one.
   */
  let underWorkspace: string | undefined
  const sayWorkspace = (text: string) => {
    if (underWorkspace === undefined) underWorkspace = statusBox.textContent ?? ""
    statusBox.textContent = text
  }
  function heard(event: Trace) {
    // A conversation not shown before, or the one shown under a journal that does not go on from what the page took (the
    // store was changed, or forgot): the Context tab starts over on it, before it hears of its journal. A chat and its
    // branch hold the same places and times up to the cut, so a switch between them is told by the session alone.
    const fresh = event._tag === "Showing" && drawsAnew(board, shownSession, event)
    if (event._tag === "Showing" && fresh) {
      shownSession = event.session
      trace.reset(event.session)
    }
    trace.hear(event)
    // Lesson 18: a recall said for a request, or a record of the knowledge session's, redraws the Graph tab.
    if (graphPane !== undefined) {
      const before = recalls
      recalls = heardRecall(recalls, event)
      if (recalls !== before) paintGraphSoon()
    }
    if (contextTab.getAttribute("aria-selected") !== "true" && !unseen) { unseen = true; contextTab.dataset.unseen = "" }
    window.dispatchEvent(new CustomEvent("learn:trace", { detail: event }))
    // Lesson 16: the Files tab reads the workspace again after a write a tool said, and after every turn's end.
    void workspacePane?.hear(event)
    const conversation = state.runtime?.conversation
    // The chat's rows first: a stored record of the conversation shown, a piece, a reply, a failure, the program's end.
    if (conversation !== undefined) show(hear(board, event, conversation))
    // Lesson 17: each task's chip, from the chat's journal, the task's own session, and the queue's traces.
    if (conversation !== undefined && lesson.tasks === true) showTasks(heardTask(taskChips, event, conversation))
    switch (event._tag) {
      case "Event": {
        const record = event.event
        if (record._tag === "Live" && record.session === conversation) {
          Option.map(dataOf(progressEvent, record), ({ id, done, total }) => views.progress(id, done, total))
          // Lesson 16: a tool wrote a file, said on the status line.
          Option.map(workspaceLine(record), sayWorkspace)
          // Lesson 14: an attempt of a model call failed, or a later one started or answered, said on the status line.
          Option.map(Option.flatMap(dataOf(attemptEvent, record), attemptLine), (text) => {
            // The program's own line is kept, and put back when the turn ends: an attempt's line says nothing after it.
            if (programStatus === undefined) programStatus = statusBox.textContent ?? ""
            statusBox.textContent = text
          })
        }
        if (record._tag !== "Stored" || record.session !== conversation) break
        // Lesson 16: a write or an edit whose result failed, so nothing was written, said on the status line.
        Option.map(workspaceLine(record), sayWorkspace)
        if (record.name === turnStartedEvent.name && underWorkspace !== undefined) {
          statusBox.textContent = underWorkspace
          underWorkspace = undefined
        }
        const { session: _session, _tag: _stored, ...kept } = record
        // A record the chat took already, read from the journal as the conversation was shown, is not taken twice.
        if (kept.seq <= (chatRecords.at(-1)?.seq ?? 0)) break
        chatRecords.push(kept)
        // What the UI shows: every view record redraws the chat's views from the fold of its records.
        if (record.name === viewEvent.name) views.draw(chatRecords)
        if (record.name === turnEndedEvent.name) {
          if (programStatus !== undefined) statusBox.textContent = programStatus
          programStatus = undefined
          views.settle()
          window.dispatchEvent(new CustomEvent("learn:done"))
        }
        break
      }
      case "Showing":
        // The journal as the store held it when the program named the conversation. One not shown before is drawn
        // from it alone; the one already shown takes the records it has not taken (a turn closed as the program started).
        if (fresh) drawFrom(event.journal, board.rows.filter((row) => row.waiting === true && row.dropped === undefined).map((row) => row.text))
        else event.journal.forEach(take)
        // Lesson 15: the row of chats, and a word when the learner's `resume` showed another chat than the one picked.
        if (lesson.branch !== undefined) void showChats(event.session)
        break
      case "Reply":
        chat.focus()
        break
      case "Failed":
        void failed(event.turn, event.message)
        break
      case "Status":
        statusBox.textContent = event.text
        programStatus = undefined
        underWorkspace = undefined
        break
      // Lesson 18: a curation cut short leaves no "Curating…" behind.
      case "CurationCut":
        statusBox.textContent = curationCutLine(event.source)
        break
      case "Ended":
        state.alive = false
        showFoot("error", `Build ${state.builds}: ${event.reason}`)
        break
      default:
        break
    }
    refresh()
  }

  /** A turn failed. The chat shows why already; a lost GPU is said in the page's own words instead, and Echo takes over. */
  const failed = async (turn: number, message: string) => {
    const lost = state.model
    if (lost?.choice.kind !== "webllm" || !/device was lost|mapAsync|GPUBuffer|Model not loaded before/i.test(message)) return
    await Promise.resolve(lost.dispose()).catch(() => undefined)
    await fallBackToEcho()
    show(said(withoutFailure(board, turn), "error", gpuLostWords(lost.choice, cpuModel(catalogue(state.device)))))
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
    if (state.loading || busy() || checking()) return
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
      if (chat.hasMessages()) show(said(board, "note", `Model: ${choice.label}`))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const noGpu = /compatible GPU|WebGPU|adapter/i.test(reason)
      models.fail(choice.id, noGpu
        ? "This device has no usable GPU for WebGPU, so this model cannot run here. See how to enable it below, or use a CPU model."
        : `Could not load: ${reason}`)
      models.open()
      if (freed) {
        await fallBackToEcho()
        if (chat.hasMessages()) show(said(board, "note", `${choice.label} did not load, and ${previous.choice.label} was released to make room, so Echo is active.`))
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
    const kept = waitingCount(board)
    try {
      // A build takes a few milliseconds; "Building…" stays long enough to be seen.
      const [result] = await Promise.all([runtime.start(editor.sources()), new Promise((resolve) => setTimeout(resolve, 400))])
      saveSources()
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
    if (editorHost.hidden) return
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
        // A file's own `export` is no statement of a function's body: the page runs the file without it.
        if (file.formatPrefix === "") new Function(source.replace(/^export /gm, ""))
        else new Function(`return (${source}\n)`)
        syntaxBox.textContent = ""
      } catch (error) {
        syntaxBox.textContent = error instanceof Error ? error.message : String(error)
      }
      syncControls()
    }, 350)
  }

  /** A file the lesson has, the Context tab, the Files and Graph tabs where the lesson has them, or the main file. */
  const tabOf = (id: string | undefined): string =>
    id === CONTEXT_TAB || (id === FILES_TAB && filesHost !== null) || (id === GRAPH_TAB && graphHost !== null) ? id : lesson.files.find((file) => file.id === id)?.id ?? lesson.mainFile
  root.querySelectorAll<HTMLButtonElement>("[data-file]").forEach((tab) => tab.addEventListener("click", () => showTab(tabOf(tab.dataset.file))))
  const showTab = (tab: string) => {
    const context = tab === CONTEXT_TAB
    const files = tab === FILES_TAB && filesHost !== null
    const graph = tab === GRAPH_TAB && graphHost !== null
    const code = !context && !files && !graph
    editorHost.hidden = !code
    traceHost.hidden = !context
    if (filesHost !== null) filesHost.hidden = !files
    if (graphHost !== null) graphHost.hidden = !graph
    formatButton.hidden = !code
    syntaxBox.hidden = !code
    if (context) { unseen = false; delete contextTab.dataset.unseen } else if (code) editor.showFile(tab)
    // The Files tab shows the workspace as it is now.
    if (files) void workspacePane?.refresh()
    // The Graph tab shows the walk picked, as the page has heard it.
    if (graph) paintGraph()
    const readOnly = lesson.files.find((file) => file.id === tab)?.readOnly === true
    formatButton.disabled = readOnly
    root.querySelectorAll<HTMLButtonElement>("[data-file]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.file === tab)))
    if (code) checkSyntaxSoon()
  }

  // ── chat ────────────────────────────────────────────────────────────────
  // ── branches (lesson 15) ────────────────────────────────────────────────
  /** The row of chats, as the store lists them; and, as a chat was shown, a word when it is not the one asked for. */
  const showChats = async (showing?: string) => {
    const runtime = state.runtime
    if (runtime === undefined) return
    const chats = await runtime.chats()
    chat.renderChats(chats, runtime.conversation)
    if (showing !== undefined) Option.map(ignoredLine(runtime.chosen, showing, chats), (line) => show(said(board, "note", line)))
  }
  /** "Branch after turn N": the learner's branchFrom makes a branch of the chat shown, which stays shown, and a turn running in it goes on. */
  const branchAfter = async (turn: TurnNumber) => {
    const runtime = state.runtime
    if (runtime === undefined) return
    const made = await runtime.branch(turn)
    if (made._tag === "Failure") { show(said(board, "error", made.failure)); return }
    await showChats()
    const label = (await runtime.chats()).find((one) => one.id === made.success)?.label ?? "A branch"
    show(said(board, "note", `${label} was made. This chat is still the one shown: pick the branch above the chat to show it.`))
  }
  /**
   * A chat of the row: it is asked for, and the program starts again over it, as Rebuild does. The messages still
   * waiting are dropped: they were written for the chat that was shown.
   */
  const chooseChat = async (id: string) => {
    const runtime = state.runtime
    const picked = (await runtime?.chats())?.find((one) => one.id === id)
    if (runtime === undefined || picked === undefined || state.building) return
    state.building = true
    state.builds++
    refresh()
    show(dropWaiting(board, "dropped: you switched chats"))
    const { result } = await runtime.choose(picked.id)
    state.building = false
    showBuild(result, `${picked.label} is asked for.`)
    refresh()
  }

  /** A new, empty conversation in the same base: the chat and the Context tab start over. */
  const newConversation = async () => {
    const runtime = await ensureRuntime()
    state.building = true
    state.builds++
    refresh()
    // What waited for a turn is dropped with the queue: it is not drawn again in the new conversation.
    show(dropWaiting(board, "dropped by Clear context"))
    // The program is stopped first, so nothing it was still saying lands in the new conversation's chat.
    const result = await runtime.clear()
    // A durable lesson's program names the new conversation as it starts, and the page draws it then.
    if (lesson.durable === undefined) {
      chat.clear()
      show(emptyChat)
      showTasks(noTasks)
      chatRecords.length = 0
      views.reset()
      trace.reset(runtime.conversation)
      graphStartedOver(runtime.conversation)
    }
    statusBox.textContent = ""
    underWorkspace = undefined
    state.building = false
    showBuild(result, "a new, empty conversation; the old one stays in the journal store.")
    refresh()
  }

  const send = (texts: ReadonlyArray<string>) => {
    const runtime = state.runtime
    if (!runtime || !state.alive || !state.model || state.building || checking()) return
    if (!busy() && waitingCount(board) === 0) window.dispatchEvent(new CustomEvent("learn:start"))
    texts.forEach((text) => {
      show(sent(board, text))
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
    show(dropWaiting(board, "dropped by Stop"))
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
    // A step about the context opens the Context tab in the Code pane; one about the files (lesson 16), its Files tab.
    const context = detail.pane === "context" || detail.file === CONTEXT_TAB
    const files = filesHost !== null && (detail.pane === FILES_TAB || detail.file === FILES_TAB)
    const graph = graphHost !== null && (detail.pane === GRAPH_TAB || detail.file === GRAPH_TAB)
    const pane = context || files || graph ? "code" : detail.pane
    if (detail.wide === "true" || context || graph) grid.dataset.wide = "true"; else delete grid.dataset.wide
    if (pane) { grid.dataset.focus = pane; root.dataset.focus = detail.pane ?? pane } else { delete grid.dataset.focus; delete root.dataset.focus }
    const file = tabOf(detail.file)
    if (file !== CONTEXT_TAB && file !== FILES_TAB && file !== GRAPH_TAB) {
      showTab(file)
      const open = new Set((detail.unfold ?? "").split(",").map((s) => s.trim()))
      const folded = lesson.files.find((entry) => entry.id === file)?.folded ?? []
      editor.foldOnly(folded.filter((section) => !open.has(section)))
    }
    if (context) showTab(CONTEXT_TAB)
    if (files) showTab(FILES_TAB)
    if (graph) showTab(GRAPH_TAB)
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
      // A choice of chips (lesson 18's names and weights) is a radio button each: the one whose value the line holds is checked.
      if (control instanceof HTMLInputElement && control.type === "radio") control.checked = Option.isSome(value) && control.value === String(value.value)
      else if (Option.isSome(value) && document.activeElement !== control) control.value = String(value.value)
    })
    document.querySelectorAll<HTMLElement>("[data-controls-note]").forEach((note) => { note.hidden = controlEls.every((control) => !control.disabled) })
  }
  let pending: ReturnType<typeof setTimeout> | undefined
  controlEls.forEach((control) => control.addEventListener("input", () => {
    const bound = controlOf(control.dataset.control ?? "")
    if (Option.isNone(bound)) return
    // A radio button says only that it was checked: the one unchecked by it writes nothing.
    if (control instanceof HTMLInputElement && control.type === "radio" && !control.checked) return
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
    // Every file the experiment edits, its own first: all are changed, or none is.
    const label = [experiment, ...(experiment.also ?? [])].map((edit) => lesson.files.find((file) => file.id === edit.file)?.label ?? edit.file).join(" and ")
    const next = applyExperiment(experiment, (file) => editor.source(file))
    if (Option.isNone(next)) {
      showFoot("error", `This experiment could not find its line in ${label}. Press Reset in the Code pane to bring it back.`)
      return
    }
    next.value.forEach(([file, text]) => editor.setSource(file, text))
    showTab(experiment.file)
    const original = button.textContent
    button.disabled = true
    button.textContent = "Applied ✓"
    await rebuild(`${label} changed by "${original?.trim()}", and runs.`)
    setTimeout(() => { button.disabled = false; button.textContent = original }, 1500)
  }))

  // "Send 5 short messages": sent at once, to build up a conversation to look at.
  /**
   * Forget everything the chat drew, and draw it again from a journal alone, as a reload would: each record goes
   * through the step a record takes live, so every stored row and view comes back where it was, and what was only
   * said (a reply never stored, the page's notes) does not.
   */
  function drawFrom(journal: ReadonlyArray<StoredEvent>, waiting: ReadonlyArray<string> = []) {
    chat.clear()
    views.reset()
    chatRecords.length = 0
    board = emptyChat
    journal.forEach(take)
    views.settle()
    // The messages that waited for a turn still wait, after everything stored.
    show(waiting.reduce((rows, text) => sent(rows, text), board))
  }
  /** One record of the conversation shown, read from its journal: the step a record takes when it is announced. */
  function take(record: StoredEvent) {
    if (record.seq <= (chatRecords.at(-1)?.seq ?? 0)) return
    show(stored(board, record))
    chatRecords.push(record)
    if (record.name === viewEvent.name) views.draw(chatRecords)
  }
  // Lesson 6: redraw the chat from the journal.
  document.querySelectorAll<HTMLButtonElement>("[data-redraw-views]").forEach((button) => button.addEventListener("click", async () => {
    const runtime = state.runtime
    if (runtime === undefined || busy()) return
    drawFrom(await runtime.journal())
  }))
  document.querySelectorAll<HTMLButtonElement>("[data-fill]").forEach((button) => button.addEventListener("click", () => send(lesson.fill)))

  // Lessons 7 and 12: run a kit over the code as it stands, and list each check under the button.
  document.querySelectorAll<HTMLButtonElement>("[data-kit]").forEach((button) => button.addEventListener("click", async () => {
    const id = button.dataset.kit ?? ""
    // The list in the button's own step: a kit may have a button in more than one.
    const list = (button.closest("[data-step]") ?? document).querySelector<HTMLElement>(`[data-kit-results="${id}"]`)
    if (list === null) return
    button.disabled = true
    const running = (await ensureRuntime()).runKit(id, editor.sources())
    // A kit that runs alone has started by now: the chat's Send goes off, and comes back on when the kit is done.
    refresh()
    const ran = await running
    button.disabled = false
    refresh()
    const line = (state: "passed" | "failed", head: string, detail: string) => {
      const item = document.createElement("li")
      item.dataset.state = state
      const name = document.createElement("strong")
      name.textContent = head
      item.append(name, detail === "" ? "" : ` ${detail}`)
      return item
    }
    // The list says what did not run in its own words (lesson 12: "The checks did not run."), else as lesson 7's does.
    list.replaceChildren(...(ran._tag === "Failure"
      ? [line("failed", list.dataset.kitRefused ?? "The kit did not run.", ran.failure)]
      : ran.success.map(kitLine).map((drawn) => line(drawn.state, drawn.head, drawn.detail))))
    list.hidden = false
  }))
  // Lesson 13: run the evals over the code as it stands, and fill the table under the button as trials end. The
  // part of the page that runs them, with the eval package, is loaded on the first press. Stop interrupts the run.
  const evalsPanes = new Map<HTMLElement, EvalsPane>()
  document.querySelectorAll<HTMLButtonElement>('[data-evals="run"]').forEach((button) => button.addEventListener("click", async () => {
    const evals = lesson.evals
    const scope = button.closest("[data-step]") ?? document
    const host = scope.querySelector<HTMLElement>("[data-evals-results]")
    if (evals === undefined || host === null) return
    const pane = evalsPanes.get(host) ?? mountEvals(host)
    evalsPanes.set(host, pane)
    const stops = [...scope.querySelectorAll<HTMLButtonElement>('[data-evals="stop"]')]
    button.disabled = true
    const runtime = await ensureRuntime()
    const running = runtime.runAlone(evals.start(editor.sources(), (view) => {
      pane.draw(view)
      stops.forEach((stop) => { stop.hidden = view.status.startsWith("Done") || view.status.startsWith("Stopped") })
    }))
    // The run takes turns with the chat: Send goes off, and comes back on when the run is over.
    refresh()
    const ran = await running
    stops.forEach((stop) => { stop.hidden = true })
    button.disabled = false
    refresh()
    // A run that did not start says why; one that ran drew its every ending, a stop included.
    if (Result.isFailure(ran)) pane.say(`The evals did not run: ${ran.failure}`)
  }))
  document.querySelectorAll<HTMLButtonElement>('[data-evals="stop"]').forEach((button) => button.addEventListener("click", () => void state.runtime?.stopAlone()))
  // Lesson 19: check the graders against the labels over the code as it stands, and fill the table under the button
  // as checks end. The part of the page that runs them, with the eval package, is loaded on the first press. Stop
  // interrupts the run.
  const gradersPanes = new Map<HTMLElement, GradersPane>()
  document.querySelectorAll<HTMLButtonElement>('[data-graders="run"]').forEach((button) => button.addEventListener("click", async () => {
    const calibration = lesson.calibration
    const scope = button.closest("[data-step]") ?? document
    const host = scope.querySelector<HTMLElement>("[data-graders-results]")
    if (calibration === undefined || host === null) return
    const pane = gradersPanes.get(host) ?? mountGraders(host)
    gradersPanes.set(host, pane)
    const stops = [...scope.querySelectorAll<HTMLButtonElement>('[data-graders="stop"]')]
    button.disabled = true
    const runtime = await ensureRuntime()
    const running = runtime.runAlone(calibration.start(editor.sources(), (view) => {
      pane.draw(view)
      stops.forEach((stop) => { stop.hidden = !view.status.startsWith("Checking") })
    }))
    // The check takes turns with the chat: Send goes off, and comes back on when the check is over.
    refresh()
    const ran = await running
    stops.forEach((stop) => { stop.hidden = true })
    button.disabled = false
    refresh()
    // A check that did not start says why; one that ran drew its every ending, a stop included.
    if (Result.isFailure(ran)) pane.say(`The graders were not checked: ${ran.failure}`)
  }))
  document.querySelectorAll<HTMLButtonElement>('[data-graders="stop"]').forEach((button) => button.addEventListener("click", () => void state.runtime?.stopAlone()))
  // Lesson 18: write the world into the knowledge session, in one turn, and say what was stored under the button. It
  // takes turns with the chat: Send and the chips are off while it runs, and it is off while a turn runs.
  document.querySelectorAll<HTMLButtonElement>("[data-world]").forEach((button) => button.addEventListener("click", async () => {
    const result = (button.closest("[data-step]") ?? document).querySelector<HTMLElement>("[data-world-result]")
    button.disabled = true
    const loading = (await ensureRuntime()).loadWorld()
    refresh()
    const loaded = await loading
    refresh()
    if (result !== null) {
      result.textContent = Result.match(loaded, { onSuccess: (words) => words, onFailure: (why) => `Nothing was stored: ${why}` })
      result.dataset.state = Result.isSuccess(loaded) ? "ok" : "error"
      result.hidden = false
    }
  }))
  // Lesson 7: reload the page as it stands, a turn in progress included.
  document.querySelectorAll<HTMLButtonElement>("[data-reload]").forEach((button) => button.addEventListener("click", () => window.location.reload()))
  // Lesson 7: forget everything this lesson stored (its journals and the edits kept for a reload), and start again.
  document.querySelectorAll<HTMLButtonElement>("[data-start-over]").forEach((button) => button.addEventListener("click", () => {
    const prefix = lesson.durable?.prefix
    if (prefix === undefined) return
    try {
      const storage = window.localStorage
      Array.from({ length: storage.length }, (_, index) => storage.key(index)).forEach((key) => { if (key !== null && key.startsWith(prefix)) storage.removeItem(key) })
      // What this tab kept for the lesson: the edits, and the chat picked (lesson 15).
      const tab = window.sessionStorage
      Array.from({ length: tab.length }, (_, index) => tab.key(index)).forEach((key) => { if (key !== null && key.startsWith(prefix)) tab.removeItem(key) })
    } catch { /* no storage: there is nothing kept to forget */ }
    window.location.reload()
  }))

  // ── start ───────────────────────────────────────────────────────────────
  // Echo and the program come up at once; the device probe (a GPU lookup that can
  // be slow or hang) only decides how the other models are described.
  refresh()
  models.render(state.device)
  void probeDevice().then((device) => { state.device = device; models.render(device) })
  const start = async (note?: string) => {
    await ensureRuntime()
    restoreSources()
    await chooseModel(echoChoice)
    await rebuild()
    syncControls()
    if (note !== undefined) show(said(board, "note", note))
    refresh()
  }
  if (lesson.durable === undefined) void start()
  else whenWriter(lesson.durable.prefix, (note) => void start(note), (text) => { setChip("open in another tab", "idle"); showFoot("idle", text) })
}

/**
 * Start a durable lesson when this page is its store's one writer. A store has one writer (ADR 0010), and the
 * page arranges it with a Web Lock named for the lesson, held while the page is open: a second tab waits, says
 * so, and starts when the first is closed. A reload gets the lock again once the page before it is gone, so the
 * notice is held back for a moment. Without Web Locks (a page served over plain http from another machine) the
 * page cannot tell: it starts, and says so in the chat.
 */
function whenWriter(prefix: string, start: (note?: string) => void, wait: (text: string) => void) {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks
  if (locks === undefined) {
    return start("This page is not served over https, so it cannot tell whether the lesson is open in another tab: keep it to one. Two tabs would write to the same journal.")
  }
  let granted = false
  setTimeout(() => { if (!granted) wait("This lesson is open in another tab, which is writing its conversation. It starts here when that tab is closed.") }, 1200)
  void locks.request(`${prefix}writer`, () => {
    granted = true
    start()
    // Held for as long as the page is open: the promise never settles.
    return new Promise<never>(() => {})
  })
}
