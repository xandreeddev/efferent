import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { makeScriptedImplementor } from "@xandreed/foundry"
import { runForgeSessionWith } from "../forge/session.js"
import {
  bootTestTui,
  proposingRefineAgent,
  stalledRefineAgent,
} from "./testing.js"
import type { TestTui } from "./testing.js"

/**
 * The TUI regression battery — the REAL App over OpenTUI's headless test
 * renderer, input as raw bytes through the production StdinParser, output
 * asserted on captured frames. Every failure this TUI shipped has its
 * regression here; a new failure class means a new test in this file.
 */

const disposals: Array<TestTui> = []
const boot = async (...args: Parameters<typeof bootTestTui>) => {
  const tui = await bootTestTui(...args)
  disposals.push(tui)
  return tui
}
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((t) => t.dispose()))
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

const waitFrame = async (
  tui: TestTui,
  predicate: (frame: string) => boolean,
  passes = 60,
): Promise<string> => {
  const attempt = async (left: number): Promise<string> => {
    const frame = await tui.frame()
    if (predicate(frame)) return frame
    if (left <= 0) return frame
    await new Promise((resolve) => setTimeout(resolve, 25))
    tui.tick()
    return attempt(left - 1)
  }
  return attempt(passes)
}

describe("the smith TUI — frame-level regressions", () => {
  test("boot renders the workspace dashboard from real fixtures", async () => {
    const tui = await boot()
    const frame = await waitFrame(tui, (f) => f.includes("specs"))
    expect(frame).toContain("no specs yet")
    expect(frame).toContain("forge runs")
    expect(frame).toContain("lessons")
    expect(frame).toContain("describe what to build")
  })

  test("':' opens the live palette; ':mo' narrows it", async () => {
    const tui = await boot()
    await tui.setup.mockInput.typeText(":")
    tui.tick(2)
    const all = await waitFrame(tui, (f) => f.includes(":quit"))
    expect(all).toContain(":forge [slug]")
    expect(all).toContain(":login")
    await tui.setup.mockInput.typeText("mo")
    tui.tick(2)
    const narrowed = await waitFrame(tui, (f) => f.includes(":model"))
    expect(narrowed).toContain(":model [code|fast]")
    expect(narrowed).not.toContain(":login  set up providers")
  })

  test(":model opens the picker; arrows + Enter persist the role", async () => {
    const tui = await boot()
    await tui.setup.mockInput.typeText(":model")
    tui.setup.mockInput.pressEnter()
    const picker = await waitFrame(tui, (f) => f.includes("Select the GENERAL model"))
    expect(picker).toContain("opencode:kimi-k2.6")
    tui.setup.mockInput.pressArrow("down")
    await settle()
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => !f.includes("Select the GENERAL model"))
    expect(tui.setRoleCalls).toHaveLength(1)
    expect(tui.setRoleCalls[0]?.role).toBe("general")
    expect(Option.isSome(tui.setRoleCalls[0]!.selection)).toBe(true)
  })

  test(":login shows status tags; a bracketed PASTE lands as masked bullets", async () => {
    const tui = await boot({
      credentials: new Map([["opencode", { type: "api_key", key: "k" }]]),
    })
    await tui.setup.mockInput.typeText(":login")
    tui.setup.mockInput.pressEnter()
    const home = await waitFrame(tui, (f) => f.includes("Sign in to your providers"))
    expect(home).toContain("OpenCode")
    expect(home).toContain("api key")
    // The home list pre-highlights the CONFIGURED provider (OpenCode here);
    // two Ups reach OpenAI (no method step → straight to the key prompt).
    // Keys are PACED — the raw-byte parser disambiguates ESC by timing.
    tui.setup.mockInput.pressArrow("up")
    await settle()
    tui.setup.mockInput.pressArrow("up")
    await settle()
    tui.setup.mockInput.pressEnter()
    const prompt = await waitFrame(tui, (f) => f.includes("Paste your API key"))
    expect(prompt).toContain("Paste your API key")
    await tui.setup.mockInput.pasteBracketedText("sk-test-123456")
    const masked = await waitFrame(tui, (f) => f.includes("•".repeat("sk-test-123456".length)))
    expect(masked).toContain("•".repeat("sk-test-123456".length))
    expect(masked).not.toContain("sk-test-123456")
    // Esc chain: prompt → home → closed (composer back).
    await settle()
    tui.setup.mockInput.pressEscape()
    await waitFrame(tui, (f) => f.includes("Sign in to your providers"))
    await settle()
    tui.setup.mockInput.pressEscape()
    await waitFrame(tui, (f) => !f.includes("Sign in to your providers"))
  })

  test("terminal QUERY RESPONSES never act as keys (DA/CPR immunity)", async () => {
    const tui = await boot()
    const before = await waitFrame(tui, (f) => f.includes("describe what to build"))
    tui.setup.renderer.stdin.emit("data", Buffer.from("\x1b[?62;22c"))
    tui.setup.renderer.stdin.emit("data", Buffer.from("\x1b[12;40R"))
    tui.setup.renderer.stdin.emit("data", Buffer.from("\x1b[?31u"))
    const after = await tui.frame()
    expect(after).toBe(before)
    expect(Option.isNone(await Effect.runPromise(tui.exitCode))).toBe(true)
  })

  test("Ctrl-C once warns and stays alive; twice exits 0 (never 130)", async () => {
    const tui = await boot()
    await waitFrame(tui, (f) => f.includes("describe what to build"))
    tui.setup.mockInput.pressCtrlC()
    const warned = await waitFrame(tui, (f) => f.includes("press Ctrl-C again"))
    expect(warned).toContain("press Ctrl-C again to quit")
    expect(Option.isNone(await Effect.runPromise(tui.exitCode))).toBe(true)
    tui.setup.mockInput.pressCtrlC()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(await Effect.runPromise(tui.exitCode)).toEqual(Option.some(0))
  })

  test("a STALLED model shows the clock and Esc interrupts (busy resets)", async () => {
    const tui = await boot({ seams: { refineAgent: stalledRefineAgent } })
    await tui.setup.mockInput.typeText("build me something")
    tui.setup.mockInput.pressEnter()
    const busy = await waitFrame(tui, (f) => f.includes("refining…"))
    expect(busy).toContain("refining…")
    tui.setup.mockInput.pressEscape()
    const freed = await waitFrame(tui, (f) => f.includes("turn interrupted"))
    expect(freed).toContain("turn interrupted")
    expect(tui.store.busy()).toBe(false)
  })

  test("the FULL loop: idea → draft → :lock → :forge → gates green → dashboard grows", async () => {
    const tui = await boot({
      seams: {
        refineAgent: proposingRefineAgent({
          goal: "Create out.txt containing done.",
          acceptance: ["out.txt exists"],
          checks: [{ name: "out-exists", command: "test -f out.txt" }],
        }),
        forgeRunner: (run, publish, doc) =>
          runForgeSessionWith(
            run,
            publish,
            makeScriptedImplementor([[{ path: "out.txt", content: "done\n" }]]),
            doc,
          ),
      },
    })
    await tui.setup.mockInput.typeText("make an out file")
    tui.setup.mockInput.pressEnter()
    const drafted = await waitFrame(tui, (f) => f.includes("Create out.txt containing done."))
    expect(drafted).toContain("draft")

    await tui.setup.mockInput.typeText(":lock")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("locked"))

    await tui.setup.mockInput.typeText(":forge")
    tui.setup.mockInput.pressEnter()
    const done = await waitFrame(tui, (f) => f.includes("accepted (attempt 1)"), 200)
    expect(done).toContain("accept-out-exists")

    await tui.setup.mockInput.typeText(":new")
    tui.setup.mockInput.pressEnter()
    const dashboard = await waitFrame(tui, (f) => f.includes("✓ accepted (attempt 1)"))
    expect(dashboard).toContain("✓ accepted (attempt 1)")
    expect(dashboard).toContain("create-out-txt-containing-done")
  })
})
