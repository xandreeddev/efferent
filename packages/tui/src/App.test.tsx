import { afterEach, describe, expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { testRender } from "@opentui/solid"
import { ConversationId } from "@xandreed/core"
import { App, WINDOW_BLOCKS } from "./App.js"
import { createTuiState } from "./state.js"

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
const boot = async (width = 80, height = 24) => {
  const state = createTuiState({ id: ConversationId.make("00000000-0000-4000-8000-000000000000"), workspace: "/workspace/demo", profile: "smith", createdAt: 0 })
  const sent: string[] = []
  const ui = await testRender(() => createComponent(App, { state, actions: { commands: [{ name: "model", description: "Choose a model" }, { name: "plugins", description: "Configure or replace plugins" }, { name: "plan", description: "Plan a task" }], submit: (text) => { sent.push(text) }, palette: () => state.setOverlay({ kind: "menu", title: "Commands", rows: [{ label: "/plugins", detail: "Configure plugins", select: () => state.setOverlay({ kind: "text", title: "Plugins", text: "loop · memory" }) }] }), interrupt: () => {}, quit: () => {} } }), { width, height })
  cleanups.push(() => ui.renderer.destroy())
  const frame = async () => { await ui.renderOnce(); return ui.captureCharFrame() }
  return { state, ui, sent, frame }
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
