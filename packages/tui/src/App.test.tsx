import { afterEach, describe, expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { testRender } from "@opentui/solid"
import { ConversationId, HarnessError } from "@xandreed/core"
import { Cause, Option } from "effect"
import { AiError } from "effect/ai"
import { App, WINDOW_BLOCKS } from "./App.js"
import { createTuiState, errorMessage } from "./state.js"
import type { JournalRenderers } from "./journal.entity.js"

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
const boot = async (width = 80, height = 24, journalRenderers: JournalRenderers = {}) => {
  const state = createTuiState({ id: ConversationId.make("00000000-0000-4000-8000-000000000000"), workspace: "/workspace/demo", profile: "smith", createdAt: 0 }, "dark", {}, journalRenderers)
  const sent: string[] = []
  const interruptions: string[] = []
  const ui = await testRender(() => createComponent(App, { state, actions: { commands: [{ name: "model", description: "Choose a model" }, { name: "plugins", description: "Configure or replace plugins" }, { name: "plan", description: "Plan a task" }], submit: (text) => { sent.push(text) }, palette: () => state.setOverlay({ kind: "menu", title: "Commands", rows: [{ label: "/plugins", detail: "Configure plugins", select: () => state.setOverlay({ kind: "text", title: "Plugins", text: "loop · memory" }) }] }), interrupt: () => { interruptions.push("stop") }, quit: () => {} } }), { width, height })
  cleanups.push(() => ui.renderer.destroy())
  const frame = async () => { await ui.renderOnce(); return ui.captureCharFrame() }
  const frameContaining = async (text: string, remaining = 40): Promise<string> => {
    const rendered = await frame()
    if (rendered.includes(text) || remaining === 0) return rendered
    await Bun.sleep(25)
    return frameContaining(text, remaining - 1)
  }
  return { state, ui, sent, interruptions, frame, frameContaining }
}

describe("Efferent terminal client", () => {
  test("conversation layout stays readable at narrow, standard and wide sizes", async () => {
    await Promise.all([[48, 24], [80, 24], [120, 40]].map(async ([width, height]) => {
      const tui = await boot(width, height)
      const frame = await tui.frame()
      expect(frame).toContain("efferent")
      expect(frame).toContain("What are we working on?")
      expect(frame).toContain("Enter send")
    }))
  })
  test("long workspace and model labels leave mode and ready or editor status visible at each viewport", async () => {
    const selection = "vercel:deepseek/deepseek-v4.1-flash"
    await [48, 80, 140].reduce(async (prior, width) => {
      await prior
      const tui = await boot(width, 24, { "host.editor": () => [{ id: "editor", kind: "notice", text: "Editor working", detail: "", status: "running", runId: "header-run", role: "Editor", model: selection, category: "handoff" }] })
      tui.state.selectSession({ ...tui.state.session(), workspace: "/workspace/a-very-long-fixture-workspace-name" })
      tui.state.setModel(selection)
      const ready = (await tui.frame()).split("\n")[0]!
      expect(ready).toContain(" · code")
      expect(ready).toMatch(/\sReady\s*$/)
      if (width < 140) expect(ready).toContain("...")
      if (width === 80) expect(ready).toContain("vercel:deepseek-v4.1-flash")
      if (width === 140) expect(ready).toContain(selection)
      const model = tui.ui.renderer.root.findDescendantById("header-model")!
      const status = tui.ui.renderer.root.findDescendantById("header-status")!
      expect(status.x).toBeGreaterThanOrEqual(model.x + model.width + 1)
      expect(status.x + status.width).toBeLessThanOrEqual(width - 1)
      tui.state.setMode("plan")
      expect((await tui.frame()).split("\n")[0]).toContain(" · plan")
      tui.state.setMode("code")
      tui.state.event({ version: 1, id: "start", sessionId: tui.state.session().id, seq: 0, at: Date.now(), name: "run.started", runId: "header-run", data: {} })
      tui.state.journal([{ session: tui.state.session().id, seq: 1, turn: Option.none(), kind: "host.editor", at: Date.now(), data: {} }])
      const active = (await tui.frame()).split("\n")[0]!
      expect(active).toContain("· code")
      expect(active).toMatch(/\sEditor · \d+s\s*$/)
      expect(active).not.toContain("Ready")
      expect(status.x).toBeGreaterThanOrEqual(model.x + model.width + 1)
    }, Promise.resolve())
  })
  test("slash opens immediately, filters while typing, and Tab keeps arguments editable", async () => {
    const tui = await boot()
    await tui.ui.mockInput.typeText("/")
    expect(await tui.frame()).toContain("Commands ·")
    expect(await tui.frame()).toContain("/plugins")
    await tui.ui.mockInput.typeText("mo")
    expect(await tui.frame()).toContain("Choose a model")
    expect(await tui.frame()).not.toContain("Configure or replace plugins")
    tui.ui.mockInput.pressTab()
    await tui.ui.mockInput.typeText("fixture:model-1")
    expect(await tui.frame()).not.toContain("Commands ·")
    tui.ui.mockInput.pressEnter()
    await tui.frame()
    expect(tui.sent).toEqual(["/model fixture:model-1"])
  })
  test("slash selection runs with Enter and Escape dismisses without losing the draft", async () => {
    const tui = await boot()
    await tui.ui.mockInput.typeText("/p")
    await tui.frame()
    tui.ui.mockInput.pressArrow("down")
    tui.ui.mockInput.pressEnter()
    await tui.frame()
    expect(tui.sent).toEqual(["/plan"])
    await tui.ui.mockInput.typeText("/mo")
    tui.ui.mockInput.pressEscape()
    await Bun.sleep(40)
    expect(await tui.frame()).not.toContain("Commands ·")
    expect(await tui.frame()).toContain("/mo")
    await tui.ui.mockInput.typeText("del")
    expect(await tui.frame()).toContain("Commands ·")
  })
  test("a slash inside prose or multiline paste does not intercept input", async () => {
    const tui = await boot()
    await tui.ui.mockInput.pasteBracketedText("path /model\n/plugins")
    expect(await tui.frame()).not.toContain("Commands ·")
    tui.ui.mockInput.pressEnter()
    await tui.frame()
    expect(tui.sent).toEqual(["path /model\n/plugins"])
  })
  test("streaming keeps the same native markdown renderer and settles in place", async () => {
    const tui = await boot(110, 32)
    const sessionId = tui.state.session().id
    tui.state.event({ version: 1, id: "start", sessionId, seq: 0, at: 0, name: "run.started", runId: "stream", data: {} })
    tui.state.delta({ name: "assistant.delta", runId: "stream", data: { channel: "text", turnIndex: 0, delta: "Stable prefix " } })
    await tui.frame()
    const renderer = tui.ui.renderer.root.findDescendantById("markdown:stream:0:assistant")
    expect(renderer).toBeDefined()
    await Array.from({ length: 40 }).reduce(async (prior, _, index) => {
      await prior
      tui.state.delta({ name: "assistant.delta", runId: "stream", data: { channel: "text", turnIndex: 0, delta: `${index} ` } })
      await Bun.sleep(35)
      expect(await tui.frame()).toContain("Stable prefix")
      expect(tui.ui.renderer.root.findDescendantById("markdown:stream:0:assistant")).toBe(renderer)
    }, Promise.resolve())
    tui.state.event({ version: 1, id: "tool", sessionId, seq: 1, at: 1, name: "loop.event", runId: "stream", data: { type: "tool_start", turnIndex: 0, toolCallId: "read", toolName: "read_file", args: {} } })
    tui.state.event({ version: 1, id: "settled", sessionId, seq: 2, at: 2, name: "loop.event", runId: "stream", data: { type: "assistant_message", turnIndex: 0, text: "Stable prefix settled" } })
    await tui.frame()
    await Bun.sleep(40)
    expect(await tui.frame()).toContain("Stable prefix settled")
    expect(tui.ui.renderer.root.findDescendantById("markdown:stream:0:assistant")).toBe(renderer)
    expect(tui.state.transcript().blocks.map((block) => block.kind)).toEqual(["assistant", "tool"])
  })
  test("a first delta arriving before its durable start appears in the live frame", async () => {
    const tui = await boot()
    tui.state.delta({ name: "assistant.delta", runId: "early", data: { channel: "text", turnIndex: 0, delta: "Waiting for cancellation" } })
    expect(await tui.frame()).not.toContain("Waiting for cancellation")
    tui.state.event({ version: 1, id: "start", sessionId: tui.state.session().id, seq: 0, at: 0, name: "run.started", runId: "early", data: {} })
    expect(tui.state.transcript().blocks.map((block) => block.text)).toEqual(["Waiting for cancellation"])
    expect(await tui.frameContaining("Waiting for cancellation")).toContain("Waiting for cancellation")
    expect(tui.state.transcript().status).toBe("Working")
  })
  test("early batched deltas replay in order and durable text settles the same renderer", async () => {
    const tui = await boot()
    const sessionId = tui.state.session().id
    tui.state.deltas(["Waiting ", "for ", "cancellation"].map((delta) => ({ name: "assistant.delta", runId: "early", data: { channel: "text", turnIndex: 0, delta } })))
    tui.state.events([{ version: 1, id: "start", sessionId, seq: 0, at: 0, name: "run.started", runId: "early", data: {} }])
    expect(tui.state.transcript().blocks.map((block) => block.text)).toEqual(["Waiting for cancellation"])
    expect(await tui.frameContaining("Waiting for cancellation")).toContain("Waiting for cancellation")
    const renderer = tui.ui.renderer.root.findDescendantById("markdown:early:0:assistant")
    tui.state.events([
      { version: 1, id: "settled", sessionId, seq: 1, at: 1, name: "loop.event", runId: "early", data: { type: "assistant_message", turnIndex: 0, text: "Settled response" } },
      { version: 1, id: "completed", sessionId, seq: 2, at: 2, name: "run.completed", runId: "early", data: { text: "Settled response", outcome: "completed" } },
    ])
    expect(await tui.frameContaining("Settled response")).toContain("Settled response")
    expect(await tui.frame()).not.toContain("Waiting for cancellation")
    expect(tui.ui.renderer.root.findDescendantById("markdown:early:0:assistant")).toBe(renderer)
    expect(tui.state.transcript().blocks).toHaveLength(1)
    expect(tui.state.transcript().status).toBe("Ready")
  })
  test("multiline paste remains one editable submission", async () => {
    const tui = await boot()
    await tui.ui.mockInput.pasteBracketedText("first line\nsecond line 🐝")
    await tui.frame()
    expect(tui.sent).toEqual([])
    tui.ui.mockInput.pressEnter()
    await tui.frame()
    expect(tui.sent).toEqual(["first line\nsecond line 🐝"])
  })
  test("menu focus cannot leak keys into the composer", async () => {
    const tui = await boot()
    tui.state.setOverlay({ kind: "menu", title: "Commands", rows: [{ label: "plugins", detail: "", select: () => tui.state.setOverlay({ kind: "text", title: "Plugins", text: "memory" }) }] })
    await tui.frame()
    tui.ui.mockInput.pressEnter()
    expect(await tui.frame()).toContain("Plugins")
    expect(tui.sent).toEqual([])
  })
  test("long menus keep the selection and help inside the dialog in a small pane", async () => {
    const tui = await boot(60, 20)
    tui.state.setModel("openai-codex:a-very-long-model-name")
    tui.state.restoreDraft("multiline\nmessage")
    tui.state.setNotice("Choose a model first. Your message is kept.")
    tui.state.setOverlay({ kind: "menu", title: "Choose a model", rows: Array.from({ length: 30 }, (_, index) => ({ label: `model-${index}`, detail: "Connected provider", select: () => {} })) })
    await tui.frame()
    tui.state.setSelection(20)
    const frame = await tui.frame()
    expect(frame).toContain("efferent")
    expect(frame).toContain("›  model-20")
    const lines = frame.split("\n")
    const border = lines.findIndex((line) => line.includes("└"))
    expect(lines.findIndex((line) => line.includes("model-20"))).toBeLessThan(border)
    expect(lines.findIndex((line) => line.includes("↑↓ select"))).toBeLessThan(border)
    expect(lines.slice(border + 1).join("\n")).not.toContain("model-")
  })
  test("setup can restore an unsent draft without submitting it", async () => {
    const tui = await boot()
    tui.state.restoreDraft("keep this request")
    expect(await tui.frame()).toContain("keep this request")
    expect(tui.sent).toEqual([])
    tui.ui.mockInput.pressEnter()
    await tui.frame()
    expect(tui.sent).toEqual(["keep this request"])
  })
  test("credential paste never enters the render tree as plaintext", async () => {
    const tui = await boot()
    tui.state.setOverlay({ kind: "edit", title: "API key", value: "", secret: true, save: () => {} })
    await tui.frame()
    await tui.ui.mockInput.pasteBracketedText("sk-private-test")
    const frame = await tui.frame()
    expect(frame).not.toContain("sk-private-test")
    expect(frame).toContain("•".repeat(15))
  })
  test("hello is ordinary composer text and idle vi motions preserve the draft", async () => {
    const tui = await boot()
    await tui.ui.mockInput.typeText("hello")
    expect(tui.state.composerText()).toBe("hello")
    expect(tui.state.composerMode()).toBe("insert")
    tui.ui.mockInput.pressEscape(); await Bun.sleep(40)
    expect(await tui.frame()).toContain("NORMAL")
    expect(tui.state.composerText()).toBe("hello")
    await tui.ui.mockInput.typeText("0lx")
    expect(tui.state.composerText()).toBe("hllo")
    await tui.ui.mockInput.typeText("ie")
    expect(tui.state.composerText()).toBe("hello")
    expect(tui.state.composerMode()).toBe("insert")
    tui.ui.mockInput.pressEscape(); await Bun.sleep(40)
    await tui.ui.mockInput.typeText("A!")
    tui.ui.mockInput.pressEnter(); await tui.frame()
    expect(tui.sent).toEqual(["hello!"])
    expect(tui.state.composerMode()).toBe("insert")
  })
  test("vim browsing and explicit filtering retain all h/j/k/l letters and inspector details", async () => {
    const tui = await boot()
    await tui.ui.mockInput.typeText("keep hello draft")
    tui.state.setInspector({ title: "Changes", rows: [
      { id: "one", label: "hello one", detail: "complete", text: "first file details" },
      { id: "two", label: "hello two", detail: "failed", text: "second file details" },
    ] })
    await tui.frame()
    await tui.ui.mockInput.typeText("j")
    expect(await tui.frame()).toContain("second file details")
    await tui.ui.mockInput.typeText("k")
    expect(await tui.frame()).toContain("first file details")
    tui.ui.mockInput.pressKey("j", { ctrl: true }); await tui.frame()
    expect(tui.state.selection()).toBe(1)
    tui.ui.mockInput.pressKey("k", { ctrl: true }); await tui.frame()
    expect(tui.state.selection()).toBe(0)
    await tui.ui.mockInput.pressKeys(["\n"]); await tui.frame()
    expect(tui.state.selection()).toBe(1)
    await tui.ui.mockInput.typeText("/hello")
    expect(tui.state.query()).toBe("hello")
    tui.ui.mockInput.pressKey("j", { ctrl: true }); await tui.frame()
    expect(tui.state.query()).toBe("hello")
    expect(tui.state.selection()).toBe(1)
    await tui.ui.mockInput.typeText("hjk")
    expect(tui.state.query()).toBe("hellohjk")
    tui.ui.mockInput.pressBackspace(); tui.ui.mockInput.pressBackspace(); tui.ui.mockInput.pressBackspace()
    tui.ui.mockInput.pressKey("g", { ctrl: true }); await tui.frame()
    await tui.ui.mockInput.typeText("l")
    expect(tui.state.inspecting()).toBe(true)
    expect(await tui.frame()).toContain("first file details")
    await tui.ui.mockInput.typeText("h")
    expect(tui.state.inspecting()).toBe(false)
    await tui.ui.mockInput.typeText("h")
    expect(tui.state.overlay().kind).toBe("none")
    expect(tui.state.composerText()).toBe("keep hello draft")
  })
  test("80x24 reserves twenty rows for the conversation and grows only with input", async () => {
    const tui = await boot(80, 24)
    await tui.frame()
    expect(tui.ui.renderer.root.findDescendantById("composer")?.height).toBe(3)
    await tui.ui.mockInput.pasteBracketedText("one\ntwo\nthree")
    await tui.frame()
    expect(tui.ui.renderer.root.findDescendantById("composer")?.height).toBe(5)
    tui.ui.mockInput.pressKey("u", { ctrl: true })
    await tui.frame()
    expect(tui.state.composerText()).toBe("")
    expect(tui.ui.renderer.root.findDescendantById("composer")?.height).toBe(3)
  })
  test("palette filtering and keyboard inspectors preserve an unsent draft", async () => {
    const tui = await boot(80, 24)
    await tui.ui.mockInput.typeText("unfinished work")
    tui.state.setOverlay({ kind: "menu", title: "Actions", rows: [
      { label: "Models", detail: "Controller and editor", select: () => {} },
      { label: "Checks", detail: "Verification results", select: () => tui.state.setInspector({ title: "Checks", rows: [
        { id: "tests", label: "Tests", detail: "passed", text: "42 tests passed", status: "complete" },
        { id: "types", label: "Types", detail: "failed", text: "src/a.ts: invalid type", status: "failed" },
      ] }) },
    ] })
    await tui.frame()
    await tui.ui.mockInput.typeText("verif")
    expect(await tui.frame()).toContain("Checks")
    expect(await tui.frame()).not.toContain("Models")
    tui.ui.mockInput.pressEnter()
    expect(await tui.frame()).toContain("42 tests passed")
    tui.ui.mockInput.pressArrow("down")
    expect(await tui.frame()).toContain("src/a.ts: invalid type")
    tui.ui.mockInput.pressEnter()
    expect(await tui.frame()).toContain("src/a.ts: invalid type")
    tui.ui.mockInput.pressEscape()
    await Bun.sleep(40)
    expect(await tui.frame()).toContain("unfinished work")
    expect(tui.state.composerText()).toBe("unfinished work")
    expect(tui.sent).toEqual([])
  })
  test("Escape closes inspections before stopping work and keeps the idle draft", async () => {
    const tui = await boot(80, 24)
    await tui.ui.mockInput.typeText("keep this draft")
    const sessionId = tui.state.session().id
    tui.state.event({ version: 1, id: "start", sessionId, seq: 0, at: Date.now(), name: "run.started", runId: "active", data: {} })
    tui.state.setInspector({ title: "Changes", rows: [{ id: "file", label: "a.ts", detail: "+2", text: "+ actual implementation" }] })
    await tui.frame()
    tui.ui.mockInput.pressEscape(); await Bun.sleep(40); await tui.frame()
    expect(tui.interruptions).toEqual([])
    expect(tui.state.composerText()).toBe("keep this draft")
    tui.ui.mockInput.pressEscape(); await Bun.sleep(40); await tui.frame()
    expect(tui.interruptions).toEqual(["stop"])
    tui.state.event({ version: 1, id: "end", sessionId, seq: 1, at: Date.now(), name: "run.cancelled", runId: "active", data: {} })
    tui.ui.mockInput.pressEscape(); await Bun.sleep(40)
    expect(await tui.frame()).toContain("keep this draft")
    expect(tui.interruptions).toEqual(["stop"])
  })
  test("completed exploration folds but failed verification stays visible", async () => {
    const tui = await boot(80, 24)
    const sessionId = tui.state.session().id
    tui.state.events([
      ...[0, 1, 2].map((index) => ({ version: 1 as const, id: String(index), sessionId, seq: index, at: index, name: "loop.event", runId: "work", data: { type: "tool_end", turnIndex: 0, toolCallId: String(index), toolName: "read_file", args: { path: `file-${index}.ts` }, result: "read", ok: true } })),
      { version: 1, id: "check", sessionId, seq: 3, at: 3, name: "loop.event", runId: "work", data: { type: "tool_end", turnIndex: 0, toolCallId: "check", toolName: "verify", args: {}, result: "test arithmetic failed", ok: false } },
    ])
    const frame = await tui.frameContaining("3 read/search calls")
    expect(frame).toContain("3 read/search calls")
    expect(frame).toContain("test arithmetic failed")
    tui.ui.mockInput.pressKey("o", { ctrl: true })
    expect(await tui.frame()).toContain("Activity")
    expect(await tui.frame()).toContain("test arithmetic failed")
    tui.ui.mockInput.pressArrow("down")
    expect(await tui.frame()).toContain("file-2.ts")
  })
  test("a failed read and its repair stay concise in the conversation and complete in the inspector", async () => {
    const tui = await boot(80, 24)
    const session = tui.state.session().id
    const record = (seq: number, kind: string, data: Record<string, unknown>) => ({ session, seq, turn: Option.some(1), kind, at: seq, data })
    const failure = "SmithToolFailure: Error: ENOENT: no such file or directory, open '/workspace/demo/missing.ts'"
    tui.state.journal([
      record(1, "turn.started", { runId: "repair", key: "repair", origin: "user", userMessage: { text: "Read the missing file and recover" }, command: {}, claimed: [], entry: "repair:0", at: 1 }),
      record(2, "memory.message", { step: 0, body: { message: { role: "assistant", content: [{ type: "tool-call", toolCallId: "missing", toolName: "read_file", input: { path: "missing.ts" } }] } } }),
      record(3, "memory.tool-result", { step: 0, body: { toolCallId: "missing", toolName: "read_file", isError: true, encoded: { error: "SmithToolFailure", message: failure }, view: failure, viewVersion: "1", subjects: [], artifacts: [], pinned: false } }),
      record(4, "memory.message", { step: 1, body: { message: { role: "assistant", content: [{ type: "tool-call", toolCallId: "fixed", toolName: "read_file", input: { path: "README.md" } }] } } }),
      record(5, "memory.tool-result", { step: 1, body: { toolCallId: "fixed", toolName: "read_file", isError: false, encoded: { content: "workspace marker" }, view: "workspace marker", viewVersion: "1", subjects: [], artifacts: [], pinned: false } }),
      record(6, "memory.message", { step: 2, body: { message: { role: "assistant", content: [{ type: "text", text: "Recovered by reading README.md successfully." }] } } }),
    ])
    const frame = await tui.frameContaining("Recovered by reading README.md successfully.")
    expect(frame).toContain("read_file · missing.ts · failed")
    expect(frame).toContain("File not found")
    expect(frame).toContain("read_file · README.md")
    expect(frame).not.toContain("ENOENT")
    expect(frame).not.toContain("/workspace/demo/missing.ts")
    expect(frame).not.toContain("Arguments")
    expect(frame.match(/Recovered by reading README.md successfully\./g)).toHaveLength(1)
    tui.ui.mockInput.pressKey("o", { ctrl: true }); await tui.frame()
    expect(await tui.frame()).toContain("workspace marker")
    await tui.ui.mockInput.typeText("j")
    const inspected = await tui.frame()
    expect(inspected).toContain("Arguments")
    expect(inspected).toContain('"path": "missing.ts"')
    expect(inspected).toContain("Result")
    expect(inspected).toContain("ENOENT")
    expect(inspected).toContain("workspace/demo/missing.ts")
    expect(tui.state.transcript().blocks.find((block) => block.summary === "File not found")?.detail).toContain(failure)
  })
  test("failed host handoffs keep provider payloads in Ctrl+O", async () => {
    const failure = 'effect/ai/AiError/AiError: OpenCode.generateText: Invalid request. {"type":"error","error":{"type":"MissingSessionID","message":"Full provider evidence"}}'
    const tui = await boot(80, 24, { "host.editor": () => [{ id: "editor", kind: "notice", text: "Editor needs another attempt", detail: failure, status: "failed", category: "handoff" }] })
    tui.state.journal([{ session: tui.state.session().id, seq: 1, turn: Option.none(), kind: "host.editor", at: 1, data: {} }])
    const frame = await tui.frameContaining("Editor needs another attempt")
    expect(frame).toContain("Invalid request.")
    expect(frame).not.toContain("effect/ai/AiError")
    expect(frame).not.toContain('"type"')
    expect(frame).not.toContain("Full provider evidence")
    tui.ui.mockInput.pressKey("o", { ctrl: true }); await tui.frame()
    expect(await tui.frame()).toContain("MissingSessionID")
    expect(await tui.frame()).toContain("provider evidence")
    const overlay = tui.state.overlay()
    expect(overlay.kind === "inspector" && overlay.rows[0]?.text).toBe(failure)
  })
  test("regional provider failures show the actionable reason and preserve their full evidence", async () => {
    const description = "This account's Privacy region excludes this model. Select Global in the provider account settings."
    const error = AiError.make({ module: "OpenCode", method: "generateText", reason: new AiError.InvalidRequestError({ description }) })
    const wrapped = `HarnessError: ${Cause.pretty(Cause.fail(error))}`
    expect(errorMessage(error)).toBe(description)
    expect(errorMessage(Cause.fail(error))).toBe(description)
    expect(errorMessage(new HarnessError({ code: "run.failed", message: wrapped }))).toBe(description)
    const evidence = `${wrapped}\nProvider evidence: the original account-region rejection`
    const tui = await boot()
    tui.state.event({ version: 1, id: "failed", sessionId: tui.state.session().id, seq: 0, at: 1, name: "run.failed", runId: "regional", data: { message: evidence } })
    const frame = await tui.frameContaining("Privacy region")
    expect(frame).toContain("Select Global")
    expect(frame).not.toContain("effect/ai/AiError")
    expect(frame).not.toContain("generateText")
    expect(frame).not.toContain("Invalid request.")
    expect(frame).not.toContain("Provider evidence")
    tui.ui.mockInput.pressKey("o", { ctrl: true }); await tui.frame()
    expect(await tui.frame()).toContain("effect/ai/AiError")
    const overlay = tui.state.overlay()
    expect(overlay.kind === "inspector" && overlay.rows[0]?.text).toBe(evidence)
  })
  test("modern controller streaming settles the same renderer and keeps editor chatter in details", async () => {
    const tui = await boot(80, 24)
    const session = tui.state.session().id
    const assistantId = `${session}:native-ui:0:assistant`
    tui.state.journal([
      { session, seq: 1, turn: Option.some(1), kind: "turn.started", at: 1, data: { runId: "native-ui", key: "input", origin: "user", userMessage: { text: "Implement a feature" }, command: {}, claimed: [], entry: "native-ui:0", at: 1 } },
      { session, seq: 2, turn: Option.some(1), kind: "harness.event", at: 2, data: { event: { version: 1, id: "start", sessionId: session, seq: 0, at: 2, name: "run.started", runId: "native-ui", data: {} } } },
    ])
    tui.state.deltas([{ name: "native.delta", runId: "native-ui", data: { sourceSession: session, event: { _tag: "assistant.delta", step: 0, channel: "text", id: "text", delta: "Controller progress" } } }])
    expect(await tui.frameContaining("Controller progress")).toContain("Controller progress")
    const renderer = tui.ui.renderer.root.findDescendantById(`markdown:${assistantId}`)
    expect(renderer).toBeDefined()
    tui.state.deltas([{ name: "native.delta", runId: "child", data: { sourceSession: "editor-session", event: { _tag: "assistant.delta", step: 0, channel: "text", id: "text", delta: "private editor work" } } }])
    tui.state.journal([
      { session, seq: 3, turn: Option.some(1), kind: "memory.message", at: 3, data: { runId: "native-ui", step: 0, body: { message: { role: "assistant", content: [{ type: "text", text: "Controller progress completed" }] } } } },
      { session, seq: 4, turn: Option.some(1), kind: "harness.event", at: 4, data: { event: { version: 1, id: "end", sessionId: session, seq: 1, at: 4, name: "run.completed", runId: "native-ui", data: { text: "Controller progress completed", outcome: "completed" } } } },
    ])
    expect(await tui.frameContaining("Controller progress completed")).toContain("Controller progress completed")
    expect(tui.ui.renderer.root.findDescendantById(`markdown:${assistantId}`)).toBe(renderer)
    expect(tui.state.transcript().blocks.filter((block) => block.kind === "assistant")).toHaveLength(1)
    expect(await tui.frame()).not.toContain("private editor work")
  })
  test("history rendering has a fixed block window", async () => {
    const tui = await boot()
    tui.state.events(Array.from({ length: 10000 }, (_, seq) => ({ version: 1 as const, id: String(seq), sessionId: tui.state.session().id, seq, at: seq, name: "input.queued", data: { id: String(seq), text: `message ${seq}` } })))
    const start = performance.now()
    const frame = await tui.frame()
    expect(frame).toContain(`${10000 - WINDOW_BLOCKS} earlier blocks`)
    expect(performance.now() - start).toBeLessThan(1000)
    expect(frame).not.toContain("message 0\n")
    const timings: number[] = []
    await Promise.all(Array.from({ length: 1 }, async () => {
      await Array.from({ length: 25 }).reduce(async (prior, _, index) => {
        await prior
        const start = performance.now()
        await tui.ui.mockInput.pasteBracketedText(String(index))
        await tui.frame()
        timings.push(performance.now() - start)
      }, Promise.resolve())
    }))
    const p95 = [...timings].sort((a, b) => a - b)[Math.floor(timings.length * .95)]!
    expect(p95).toBeLessThan(50)
  })
})
