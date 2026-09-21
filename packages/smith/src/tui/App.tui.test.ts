import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { FactoryRun, makeScriptedImplementor } from "@xandreed/foundry"
import { SpecDoc } from "@xandreed/core"
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

  test("profile mode renders the reviewed rule/check dry-run and locked artifact", async () => {
    const tui = await boot()
    tui.store.setMode("profile")
    tui.store.reduce({
      type: "profile_draft",
      draftDir: ".efferent/profile-draft",
      rules: [
        { rule: "effect/no-let", findings: 0 },
        { rule: "architecture/no-raw-promise-core", findings: 2 },
      ],
      boundaryViolations: 1,
      checks: [
        { name: "typecheck", status: "green" },
        { name: "scenarios", status: "red" },
      ],
    })
    const draft = await waitFrame(tui, (frame) => frame.includes("quality profile"))
    expect(draft).toContain("effect/no-let")
    expect(draft).toContain("architecture/no-raw-promise-core")
    expect(draft).toContain("draft — revise or :lock")
    expect(draft).toContain("standing checks")

    tui.store.reduce({
      type: "profile_locked",
      configPath: "foundry.config.ts",
      rules: 2,
      grandfathered: 0,
      checks: 2,
    })
    const locked = await waitFrame(tui, (frame) => frame.includes("profile locked"))
    expect(locked).toContain("foundry.config.ts")
    expect(locked).toContain("locked")
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

  test("Tab completes a unique ':' command in the composer", async () => {
    const tui = await boot()
    await tui.setup.mockInput.typeText(":mo")
    tui.setup.mockInput.pressTab()
    await tui.frame()
    // The composer buffer now holds the full command + a trailing space,
    // ready for its argument — no stray tab character.
    expect(tui.store.composerText()).toBe(":model ")
  })

  test("Tab extends an ambiguous ':' prefix to the shared stem", async () => {
    const tui = await boot()
    await tui.setup.mockInput.typeText(":l")
    tui.setup.mockInput.pressTab()
    await tui.frame()
    // lock / login / logout share 'lo' — Tab fills to the branch point.
    expect(tui.store.composerText()).toBe(":lo")
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
    // two Ups reach OpenAI, then its second-level method selector chooses
    // the API-key route (subscription and API remain distinct credentials).
    // Keys are PACED — the raw-byte parser disambiguates ESC by timing.
    tui.setup.mockInput.pressArrow("up")
    await settle()
    tui.setup.mockInput.pressArrow("up")
    await settle()
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("Use a subscription (OAuth — ChatGPT Plus/Pro)"))
    tui.setup.mockInput.pressArrow("down")
    await settle()
    tui.setup.mockInput.pressEnter()
    const prompt = await waitFrame(tui, (f) => f.includes("Paste your API key"))
    expect(prompt).toContain("Paste your API key")
    await tui.setup.mockInput.pasteBracketedText("sk-test-123456")
    const masked = await waitFrame(tui, (f) => f.includes("•".repeat("sk-test-123456".length)))
    expect(masked).toContain("•".repeat("sk-test-123456".length))
    expect(masked).not.toContain("sk-test-123456")
    // Esc chain: prompt → method → home → closed (composer back).
    await settle()
    tui.setup.mockInput.pressEscape()
    await waitFrame(tui, (f) => f.includes("Use a subscription (OAuth — ChatGPT Plus/Pro)"))
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

  test("the composer is FRAMED: rule above, rule below, footer hints + model readout", async () => {
    const tui = await boot()
    const isRule = (line: string) => /─{40,}/.test(line)
    const frame = await waitFrame(tui, (f) => f.split("\n").some(isRule))
    const lines = frame.split("\n")
    // The frame's rules are the ONLY full-width rules — the composer sits
    // directly under the first, bare (no placeholder tooltip).
    const ruleIdxs = lines.flatMap((line, index) => (isRule(line) ? [index] : []))
    expect(ruleIdxs.length).toBeGreaterThanOrEqual(2)
    const [top, bottom] = [ruleIdxs[0] ?? -1, ruleIdxs[ruleIdxs.length - 1] ?? -1]
    expect((lines[top + 1] ?? "").trimStart().startsWith(">")).toBe(true)
    expect((lines[top + 1] ?? "")).not.toContain("describe what to build") // no placeholder
    // The footer under the bottom rule: hints left, the model readout right.
    const footer = lines[bottom + 1] ?? ""
    expect(footer).toContain(": for commands")
    expect(footer).toContain("● general g")
  })

  test(":settings opens the menu (roles + current values); Enter edits via the model picker", async () => {
    const tui = await boot()
    await tui.setup.mockInput.typeText(":settings")
    tui.setup.mockInput.pressEnter()
    const menu = await waitFrame(tui, (f) => f.includes("general model"))
    expect(menu).toContain("code model")
    expect(menu).toContain("fast model")
    // The P2.1 keys ride the same menu with their current values as tags.
    expect(menu).toContain("fallback model")
    expect(menu).toContain("sandbox")
    expect(menu).toContain("max forge attempts")
    expect(menu).toContain("forge budget")
    // Current values render as tags (the harness roles are g/c/f).
    expect(menu).toContain("g")
    // Enter on the highlighted row (general) opens the MODEL PICKER — the
    // settings menu composes the existing design-system overlays.
    tui.setup.mockInput.pressEnter()
    const picker = await waitFrame(tui, (f) => f.includes("Select the GENERAL model"))
    expect(picker).toContain("Select the GENERAL model")
    expect(tui.store.overlay().kind).toBe("select")
  })

  test(":settings → fallback model opens ITS picker with a clear row", async () => {
    const tui = await boot()
    await tui.setup.mockInput.typeText(":settings")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("fallback model"))
    // Filter down to the fallback row, then Enter.
    await tui.setup.mockInput.typeText("fallback")
    tui.setup.mockInput.pressEnter()
    const picker = await waitFrame(tui, (f) => f.includes("Select the FALLBACK model"))
    expect(picker).toContain("none")
    const overlay = tui.store.overlay()
    expect(overlay.kind === "select" && overlay.purpose.tag).toBe("fallback-model")
  })

  test("a fast-input BURST (Enter inside the chunk) submits the head, keeps the tail", async () => {
    const tui = await boot()
    // Simulate the burst at the seam the poll watches: the composer buffer
    // holds "hello\rworld" as one chunk — no return key event ever fired.
    tui.store.setComposer("hello\rworld")
    const sent = await waitFrame(tui, (f) => f.includes("> hello") || f.includes("hello"))
    expect(sent).toContain("hello")
    // The tail stays in the composer, still being typed.
    await waitFrame(tui, () => tui.store.composerText() === "world")
    expect(tui.store.composerText()).toBe("world")
  })

  test("after a finished forge, plain text is FOLLOW-UP (the coder keeps its context), not a new spec", async () => {
    const followUps: Array<{ readonly cid: string; readonly text: string }> = []
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
            makeScriptedImplementor(
              [[{ path: "out.txt", content: "done\n" }]],
              { ref: "conversation:00000000-0000-4000-8000-00000f0110c9" },
            ),
            doc,
          ),
        followUp: (_run, cid, text, publish) =>
          Effect.gen(function* () {
            followUps.push({ cid: String(cid), text })
            yield* publish({
              type: "agent",
              event: {
                type: "assistant_message",
                turnIndex: 0,
                text: "ran the follow-up",
                reasoning: "",
                toolCalls: [],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 },
              },
            })
          }),
      },
    })
    await tui.setup.mockInput.typeText("make an out file")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("Create out.txt containing done."))
    await tui.setup.mockInput.typeText(":lock")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("locked by you"))
    await tui.setup.mockInput.typeText(":forge")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("✓ ACCEPTED"), 200)
    // Wait for the ARMING notice (the forge fiber's completion taps) — the
    // window between forge_end rendering and the fiber finishing queues
    // typed text (drained into the first follow-up either way).
    await waitFrame(tui, (f) => f.includes("follow up freely"), 200)
    // HARD check: the arming actually happened (waitFrame resolves on
    // timeout, so the frame alone proves nothing).
    expect(tui.store.notice()).toContain("follow up freely")
    // Plain text now CONTINUES the coder's conversation…
    await tui.setup.mockInput.typeText("now run the tests again and check negatives")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("ran the follow-up"), 200)
    expect(followUps).toHaveLength(1)
    expect(followUps[0]?.cid).toBe("00000000-0000-4000-8000-00000f0110c9")
    expect(followUps[0]?.text).toContain("check negatives")
    // …and did NOT start a new refine (the mode stays on the forge floor).
    expect(tui.store.mode()).toBe("forge")
  }, 30_000)

  test("typing while the refiner is busy QUEUES the message (shown, not dropped)", async () => {
    const tui = await boot({ seams: { refineAgent: stalledRefineAgent } })
    await tui.setup.mockInput.typeText("build me something")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, () => tui.store.busy())
    // A second submission while the turn is in flight: queued, not dropped.
    await tui.setup.mockInput.typeText("also add tests")
    tui.setup.mockInput.pressEnter()
    const queued = await waitFrame(tui, (f) => f.includes("queued"))
    expect(queued).toContain("also add tests")
    expect(tui.store.queued()).toContain("also add tests")
  })

  test("queued messages are drained into the NEXT turn, all at once", async () => {
    const tui = await boot({
      seams: {
        refineAgent: proposingRefineAgent({
          goal: "Create out.txt containing done.",
          acceptance: ["out.txt exists"],
          checks: [{ name: "out-exists", command: "test -f out.txt" }],
        }),
      },
    })
    // Pre-queue a message; the first turn must drain it into a second turn —
    // deterministic (no timing race), exercising the exact drain path.
    tui.store.enqueue("and a second thought")
    await tui.setup.mockInput.typeText("first thought")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, () => {
      const users = tui.store.conversation().blocks.filter((b) => b.kind === "user")
      return users.length >= 2 && !tui.store.busy()
    })
    const users = tui.store
      .conversation()
      .blocks.flatMap((b) => (b.kind === "user" ? [b.text] : []))
    expect(users).toContain("first thought")
    expect(users.some((t) => t.includes("and a second thought"))).toBe(true)
    // The queue is emptied by the drain, not left pending.
    expect(tui.store.queued()).toEqual([])
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
    // The conversation pane carries the user's line at full width.
    expect(drafted).toContain("> make an out file")
    expect(drafted).toContain("conversation — the refiner")
    // The flow stepper names the phase and the human's next move.
    expect(drafted).toContain("the flow")
    expect(drafted).toContain("draft up — iterate in the composer")
    expect(drafted).toContain(":lock when the spec is right")

    await tui.setup.mockInput.typeText(":lock")
    tui.setup.mockInput.pressEnter()
    const lockedFrame = await waitFrame(tui, (f) => f.includes("locked by you"))
    expect(lockedFrame).toContain(":forge to build")

    await tui.setup.mockInput.typeText(":forge")
    tui.setup.mockInput.pressEnter()
    const done = await waitFrame(tui, (f) => f.includes("accepted (attempt 1)"), 200)
    expect(done).toContain("accept-out-exists")
    // The verdict is UNMISSABLE: it lands in the conversation story itself,
    // not only in the stepper (a live run was accepted and read as dead).
    expect(done).toContain("✓ ACCEPTED after 1 attempt")
    expect(done).toContain("artifact .foundry/runs/")

    // :ship follows the acceptance — the harness Shell answers the git/gh
    // sequence, the PR URL lands on the notice line, the steps in the pane.
    await tui.setup.mockInput.typeText(":ship")
    tui.setup.mockInput.pressEnter()
    // Wait on the LAST pane row (the queue pumps events after the notice sets).
    const shipped = await waitFrame(tui, (f) => f.includes("ship pr"), 200)
    expect(shipped).toContain("shipped: https://github.com/test/repo/pull/1")
    expect(shipped).toContain("ship commit")

    await tui.setup.mockInput.typeText(":new")
    tui.setup.mockInput.pressEnter()
    const dashboard = await waitFrame(tui, (f) => f.includes("✓ accepted (attempt 1)"))
    expect(dashboard).toContain("✓ accepted (attempt 1)")
    expect(dashboard).toContain("create-out-txt-containing-done")
    // The FAST model named the session after its first turn (stubbed here).
    const titled = await waitFrame(tui, (f) => f.includes("scripted session title"))
    expect(titled).toContain("scripted session title")
  })

  test("an UNCONFIGURED workspace boots into the onboarding checklist", async () => {
    const tui = await boot({ credentials: new Map() })
    const frame = await waitFrame(tui, (f) => f.includes("no provider connected"))
    expect(frame).toContain("E F F E R E N T")
    expect(frame).toContain("no provider connected")
    expect(frame).toContain(":login opens the provider manager")
    expect(frame).toContain("then describe what to build")
    expect(frame).not.toContain("forge runs")
  })

  test("a configured workspace shows the brand mark and the provider strip", async () => {
    const tui = await boot()
    const frame = await waitFrame(tui, (f) => f.includes("providers"))
    expect(frame).toContain("E F F E R E N T")
    expect(frame).toContain("✓ opencode")
    expect(frame).toContain("api key")
    expect(frame).toContain("anthropic")
    expect(frame).toContain("sessions")
  })

  test(":resume lists previous sessions and REPLAYS one into the live transcript", async () => {
    const tui = await boot()
    // Seed a finished conversation straight into the workspace db — the same
    // rows the store writes.
    const db = new Database(join(tui.cwd, ".efferent", "smith.db"))
    const cid = "00000000-0000-4000-8000-00000000fee1"
    db.query(
      "INSERT INTO conversations (id, workspace_dir, title, created_at) VALUES (?, ?, ?, ?)",
    ).run(cid, tui.cwd, "the fibonacci helper", Date.now() - 120_000)
    db.query(
      "INSERT INTO messages (conversation_id, position, content, created_at) VALUES (?, ?, ?, ?)",
    ).run(cid, 0, JSON.stringify({ role: "user", content: "write a fibonacci helper" }), 1)
    db.query(
      "INSERT INTO messages (conversation_id, position, content, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      cid,
      1,
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "Drafted the fibonacci spec with two checks." }],
      }),
      2,
    )
    db.close()

    // :new refreshes the dashboard — the seeded session appears.
    await tui.setup.mockInput.typeText(":new")
    tui.setup.mockInput.pressEnter()
    const listed = await waitFrame(tui, (f) => f.includes("the fibonacci helper"))
    expect(listed).toContain("the fibonacci helper")

    await tui.setup.mockInput.typeText(":resume")
    tui.setup.mockInput.pressEnter()
    const picker = await waitFrame(tui, (f) => f.includes("Resume a session"))
    expect(picker).toContain("the fibonacci helper")
    await settle()
    tui.setup.mockInput.pressEnter()
    const resumed = await waitFrame(tui, (f) => f.includes("session resumed"))
    expect(resumed).toContain("write a fibonacci helper")
    expect(resumed).toContain("Drafted the fibonacci spec")
  })

  test("a LONG conversation keeps the tail at the bottom and the chrome intact", async () => {
    // The fused-rows class: 40 turns of reasoning + tools + tags once made
    // yoga COMPRESS block heights and interleave text. The scrollbox +
    // flexShrink-0 blocks must keep the newest turn readable and the status
    // strip un-overdrawn at any history length.
    const tui = await boot()
    tui.store.setMode("refine")
    tui.store.addUserLine("stress the pane")
    Array.from({ length: 40 }, (_, i) => i).forEach((i) => {
      tui.store.reduce({
        type: "agent",
        event: {
          type: "assistant_message",
          turnIndex: i,
          text: `turn ${i} reply — every row stays honest under load`,
          reasoning: `thinking about step ${i} with enough words that the line wraps at least once across the pane`,
          model: "opencode:kimi-k2.6",
          toolCalls: [],
          usage: { inputTokens: 1000 + i, outputTokens: 40, totalTokens: 1040 + i, cacheReadTokens: 0 },
        },
      })
      tui.store.reduce({
        type: "agent",
        event: { type: "tool_start", turnIndex: i, toolCallId: `t${i}`, toolName: "read_file", args: { path: `src/f${i}.ts` } },
      })
      tui.store.reduce({
        type: "agent",
        event: { type: "tool_end", turnIndex: i, toolCallId: `t${i}`, toolName: "read_file", args: {}, ok: true, result: {} },
      })
    })
    const frame = await waitFrame(tui, (f) => f.includes("turn 39 reply"))
    // The newest turn owns the bottom of the story, its ▸ header carrying
    // the model + spend (thinking turns get no separate └ line)…
    expect(frame).toContain("turn 39 reply")
    expect(frame).toContain("▸ opencode:kimi-k2.6 · turn 1k in · 40 out")
    // …the ctx gauge reads the LATEST turn's input tokens (the scripted
    // model "g" has no known window → absolute only)…
    expect(frame).toContain("ctx 1k")
    // …and the chrome survives — the status strip is not overdrawn.
    expect(frame).toContain("● general")
  })

  test("a spec with MANY checks renders the compact gate tally, never overflow", async () => {
    const tui = await boot({
      seams: {
        refineAgent: proposingRefineAgent({
          goal: "Create out.txt containing done.",
          acceptance: ["out.txt exists"],
          checks: Array.from({ length: 8 }, (_, i) => ({
            name: `a-rather-long-acceptance-check-name-${i}`,
            command: "test -f out.txt",
          })),
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
    await waitFrame(tui, (f) => f.includes("Create out.txt containing done."))
    await tui.setup.mockInput.typeText(":lock")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("locked"))
    await tui.setup.mockInput.typeText(":forge")
    tui.setup.mockInput.pressEnter()
    const done = await waitFrame(tui, (f) => f.includes("accepted (attempt 1)"), 200)
    // The tally renders (✓9 = bun-test skipped? 8 accepts + typecheck-ish —
    // assert the SHAPE, not the exact count) and no raw cell soup bleeds in.
    expect(done).toMatch(/✓\d+ ✗\d+/)
    expect(done).not.toContain("a-rather-long-acceptance-check-name-7")
  })

  test("vi NORMAL: keys are swallowed (never inserted), motions edit, i re-enters insert", async () => {
    const tui = await boot()
    tui.store.setViEnabled(true)
    await tui.setup.mockInput.typeText("hello")
    await waitFrame(tui, () => tui.store.composerText() === "hello")
    tui.setup.mockInput.pressEscape()
    await waitFrame(tui, () => tui.store.vi().mode === "normal")
    const badge = await waitFrame(tui, (f) => f.includes("-- NORMAL --"))
    expect(badge).toContain("-- NORMAL --")
    // The textarea stays FOCUSED in normal mode — these keys reach dispatch
    // first (preventDefault), so they must EDIT, never insert themselves:
    // 0 → line start, x → delete under cursor.
    await tui.setup.mockInput.typeText("0")
    await tui.setup.mockInput.typeText("x")
    await waitFrame(tui, () => tui.store.composerText() === "ello")
    expect(tui.store.composerText()).toBe("ello")
    // i re-enters insert; typing lands in the buffer again (at the cursor,
    // which x left at column 0).
    await tui.setup.mockInput.typeText("i")
    await waitFrame(tui, () => tui.store.vi().mode === "insert")
    await tui.setup.mockInput.typeText("h")
    await waitFrame(tui, () => tui.store.composerText() === "hello")
    expect(tui.store.composerText()).toBe("hello")
    expect(tui.store.vi().mode).toBe("insert")
  }, 15_000)
})

describe("the smith TUI — session honesty (Esc, :resume)", () => {
  test("Esc on the idle dashboard clears the composer — it never 'interrupts' a run that isn't there", async () => {
    const tui = await boot()
    await waitFrame(tui, (f) => f.includes("describe what to build"))
    await tui.setup.mockInput.typeText("half a thought")
    await waitFrame(tui, () => tui.store.composerText() === "half a thought")
    tui.setup.mockInput.pressEscape()
    await waitFrame(tui, () => tui.store.composerText() === "")
    expect(tui.store.composerText()).toBe("")
    expect(tui.store.notice()).not.toContain("interrupting")
  })

  test("after a finished forge, Esc interrupts a STALLED follow-up turn (busy resets)", async () => {
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
            makeScriptedImplementor(
              [[{ path: "out.txt", content: "done\n" }]],
              { ref: "conversation:00000000-0000-4000-8000-00000f0110c9" },
            ),
            doc,
          ),
        followUp: () => Effect.never,
      },
    })
    await tui.setup.mockInput.typeText("make an out file")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("Create out.txt containing done."))
    await tui.setup.mockInput.typeText(":lock")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("locked by you"))
    await tui.setup.mockInput.typeText(":forge")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("✓ ACCEPTED"), 200)
    await waitFrame(tui, (f) => f.includes("follow up freely"), 200)
    await tui.setup.mockInput.typeText("poke the edges")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, () => tui.store.busy(), 200)
    expect(tui.store.busy()).toBe(true)
    // The floor reads "done" here — before, Esc only looked at the floor and
    // cleared the composer instead, leaving the stalled turn unreachable.
    tui.setup.mockInput.pressEscape()
    const freed = await waitFrame(tui, (f) => f.includes("turn interrupted"), 200)
    expect(freed).toContain("turn interrupted")
    expect(tui.store.busy()).toBe(false)
  })

  test(":resume while a refine turn is STALLED interrupts it and replays into a clean story", async () => {
    const tui = await boot({ seams: { refineAgent: stalledRefineAgent } })
    await tui.setup.mockInput.typeText("build me something")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("refining…"))
    expect(tui.store.busy()).toBe(true)
    tui.ctx.resume?.("0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f")
    const resumed = await waitFrame(tui, (f) => f.includes("session resumed"), 200)
    expect(resumed).toContain("session resumed")
    expect(tui.store.busy()).toBe(false)
    // The replaced story does not carry the interrupted session's line.
    expect(resumed).not.toContain("build me something")
  })
})

describe("the smith TUI — the dashboard is a menu", () => {
  const specDoc = (
    slug: string,
    status: "draft" | "locked",
    goal: string,
    checks: ReadonlyArray<{ readonly name: string; readonly command: string }> = [],
  ) =>
    Schema.decodeUnknownSync(SpecDoc)({
      slug,
      status,
      created: "2026-09-04T00:00:00.000Z",
      ...(status === "locked" ? { locked: "2026-09-04T00:00:00.000Z" } : {}),
      goal,
      acceptance: ["bun test exits 0"],
      constraints: [],
      nonGoals: [],
      checks,
      limits: { maxAttempts: 3, budgetMinutes: 15 },
      gates: {},
    })
  const factoryRun = Schema.decodeUnknownSync(FactoryRun)({
    id: "22222222-2222-4222-8222-222222222222",
    spec: {
      goal: "Port the stats module to TypeScript with tests.",
      acceptance: ["bun test exits 0"],
      limits: { maxAttempts: 3, budgetMillis: 1000 },
    },
    attempts: [
      {
        attempt: 1,
        report: {
          verdicts: [
            { _tag: "pass", gate: "typecheck", durationMs: 1, findings: [] },
            { _tag: "pass", gate: "bun-test", durationMs: 1, findings: [] },
          ],
        },
        filesTouched: ["src/stats.ts"],
        durationMs: 5,
        implementorRef: "conversation:00000000-0000-4000-8000-00000f0110c9",
      },
    ],
    outcome: { _tag: "accepted", attempt: 1 },
    startedAt: 0,
    endedAt: 10,
  })

  test("Tab focuses the dashboard; ↑/↓ move the cursor; ⏎ opens the row's verbs; Esc closes them", async () => {
    const tui = await boot({
      specs: [
        specDoc("stats-module", "locked", "A stats module with tests."),
        specDoc("cli-flags", "draft", "Parse the flags."),
      ],
    })
    const idle = await waitFrame(tui, (f) => f.includes("cli-flags"))
    expect(idle).toContain("Tab focuses a row")
    expect(idle).toContain("Tab → the dashboard")
    // Specs list alphabetically: the draft cli-flags sits above stats-module.
    tui.setup.mockInput.pressTab()
    const focused = await waitFrame(tui, (f) => f.includes("> · cli-flags"))
    expect(focused).toContain("> · cli-flags")
    expect(focused).toContain("↑/↓ move · ⏎ act")
    await settle()
    tui.setup.mockInput.pressArrow("down")
    const moved = await waitFrame(tui, (f) => f.includes("> ✓ stats-module"))
    expect(moved).toContain("> ✓ stats-module")
    await settle()
    tui.setup.mockInput.pressEnter()
    const verbs = await waitFrame(tui, (f) => f.includes("spec stats-module — locked"))
    expect(verbs).toContain("forge")
    expect(verbs).toContain("open")
    expect(verbs).toContain("delete")
    expect(verbs).not.toContain("approve it as-is")
    await settle()
    tui.setup.mockInput.pressEscape()
    const closed = await waitFrame(tui, (f) => !f.includes("spec stats-module — locked"))
    expect(closed).not.toContain("spec stats-module — locked")
    expect(Option.isNone(tui.store.dashboardFocus())).toBe(true)
  })

  test("Tab with text in the composer still completes a command — the dashboard never steals it", async () => {
    const tui = await boot({ specs: [specDoc("stats-module", "locked", "A stats module.")] })
    await waitFrame(tui, (f) => f.includes("stats-module"))
    await tui.setup.mockInput.typeText(":mo")
    tui.setup.mockInput.pressTab()
    await tui.frame()
    expect(tui.store.composerText()).toBe(":model ")
    expect(Option.isNone(tui.store.dashboardFocus())).toBe(true)
  })

  test("lock from the menu locks the draft ON DISK and the dashboard shows it", async () => {
    const tui = await boot({ specs: [specDoc("cli-flags", "draft", "Parse the flags.")] })
    await waitFrame(tui, (f) => f.includes("· cli-flags"))
    tui.setup.mockInput.pressTab()
    await waitFrame(tui, (f) => f.includes("> · cli-flags"))
    await settle()
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("spec cli-flags — draft"))
    await tui.setup.mockInput.typeText("lock")
    await settle()
    tui.setup.mockInput.pressEnter()
    const locked = await waitFrame(tui, (f) => f.includes("locked cli-flags"), 100)
    expect(locked).toContain("✓ cli-flags")
    const onDisk = readFileSync(join(tui.cwd, ".efferent", "specs", "cli-flags.md"), "utf8")
    expect(onDisk).toContain("status: locked")
  })

  test("open from the menu drops a locked spec into refine mode with :forge armed", async () => {
    const tui = await boot({
      // A locked spec with a machine check — the scripted coder satisfies it.
      specs: [
        specDoc("stats-module", "locked", "A stats module with tests.", [
          { name: "out-exists", command: "test -f out.txt" },
        ]),
      ],
      seams: {
        forgeRunner: (run, publish, doc) =>
          runForgeSessionWith(
            run,
            publish,
            makeScriptedImplementor([[{ path: "out.txt", content: "done\n" }]], {
              ref: "conversation:00000000-0000-4000-8000-00000f0110c9",
            }),
            doc,
          ),
      },
    })
    await waitFrame(tui, (f) => f.includes("stats-module"))
    await tui.setup.mockInput.typeText(":open")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("Open — specs"))
    await settle()
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("spec stats-module — locked"))
    await tui.setup.mockInput.typeText("open")
    await settle()
    tui.setup.mockInput.pressEnter()
    const opened = await waitFrame(tui, (f) => f.includes("opened stats-module (locked)"), 100)
    expect(opened).toContain("A stats module with tests.")
    expect(opened).toContain("locked by you")
    // The opened spec IS the session's draft: :forge builds it right away.
    await tui.setup.mockInput.typeText(":forge")
    tui.setup.mockInput.pressEnter()
    const accepted = await waitFrame(tui, (f) => f.includes("✓ ACCEPTED"), 200)
    expect(accepted).toContain("✓ ACCEPTED")
  }, 20_000)

  test("a run's menu replays its report into the floor; follow-up continues THAT coder conversation", async () => {
    const followUps: Array<{ readonly cid: string; readonly text: string }> = []
    const tui = await boot({
      runs: [factoryRun],
      seams: {
        followUp: (_run, cid, text, publish) =>
          Effect.gen(function* () {
            followUps.push({ cid: String(cid), text })
            yield* publish({
              type: "agent",
              event: {
                type: "assistant_message",
                turnIndex: 0,
                text: "ran the follow-up",
                reasoning: "",
                toolCalls: [],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0 },
              },
            })
          }),
      },
    })
    await waitFrame(tui, (f) => f.includes("accepted (attempt 1)"))
    await tui.setup.mockInput.typeText(":open")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("Open — specs"))
    await tui.setup.mockInput.typeText("accepted")
    await settle()
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("forge run —"))
    await tui.setup.mockInput.typeText("follow")
    await settle()
    tui.setup.mockInput.pressEnter()
    const replayed = await waitFrame(tui, (f) => f.includes("follow up freely"), 100)
    // The floor reads like the run just finished — attempt row, gates, verdict.
    expect(replayed).toContain("#1")
    expect(replayed).toContain("✓ ACCEPTED after 1 attempt")
    expect(replayed).toContain("Port the stats module")
    await tui.setup.mockInput.typeText("poke the edges")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("ran the follow-up"), 200)
    expect(followUps).toEqual([
      { cid: "00000000-0000-4000-8000-00000f0110c9", text: "poke the edges" },
    ])
  }, 20_000)

  test("delete asks first; confirming removes the spec file and the row", async () => {
    const tui = await boot({ specs: [specDoc("cli-flags", "draft", "Parse the flags.")] })
    await waitFrame(tui, (f) => f.includes("· cli-flags"))
    tui.setup.mockInput.pressTab()
    await waitFrame(tui, (f) => f.includes("> · cli-flags"))
    await settle()
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("spec cli-flags — draft"))
    await tui.setup.mockInput.typeText("delete")
    await settle()
    tui.setup.mockInput.pressEnter()
    const asked = await waitFrame(tui, (f) => f.includes("delete spec cli-flags?"))
    expect(asked).toContain("keep it")
    expect(existsSync(join(tui.cwd, ".efferent", "specs", "cli-flags.md"))).toBe(true)
    await settle()
    tui.setup.mockInput.pressArrow("down")
    await settle()
    tui.setup.mockInput.pressEnter()
    const gone = await waitFrame(tui, (f) => f.includes("deleted cli-flags"), 100)
    expect(gone).toContain("no specs yet")
    expect(existsSync(join(tui.cwd, ".efferent", "specs", "cli-flags.md"))).toBe(false)
  })

  test(":new after a finished forge leaves no stale status rows on the dashboard", async () => {
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
            makeScriptedImplementor([[{ path: "out.txt", content: "done\n" }]], {
              ref: "conversation:00000000-0000-4000-8000-00000f0110c9",
            }),
            doc,
          ),
      },
    })
    await tui.setup.mockInput.typeText("make an out file")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("Create out.txt containing done."))
    await tui.setup.mockInput.typeText(":lock")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("locked by you"))
    await tui.setup.mockInput.typeText(":forge")
    tui.setup.mockInput.pressEnter()
    const done = await waitFrame(tui, (f) => f.includes("✓ ACCEPTED"), 200)
    expect(done).toContain("accepted (attempt 1) · artifact")
    await waitFrame(tui, (f) => f.includes("follow up freely"), 200)
    await tui.setup.mockInput.typeText(":new")
    tui.setup.mockInput.pressEnter()
    // The run itself is on the dashboard — as a row, where it belongs — and
    // the dashboard arrives already refreshed (never the previous one).
    const dashboard = await waitFrame(tui, (f) => f.includes("✓ accepted (attempt 1)"), 200)
    expect(dashboard).toContain("✓ accepted (attempt 1)")
    expect(dashboard).not.toContain("accepted (attempt 1) · artifact")
    expect(dashboard).not.toContain("persisted in .efferent/smith.db")
    expect(dashboard).not.toContain("follow up freely")
  }, 20_000)
})

describe("the smith TUI — the context set (:context)", () => {
  test(":context add pins a file with its size; the menu lists it; drop removes it", async () => {
    const tui = await boot()
    writeFileSync(join(tui.cwd, "notes.md"), "# notes\nkeep the API stable\n")
    await waitFrame(tui, (f) => f.includes("no pins"))
    await tui.setup.mockInput.typeText(":context add notes.md")
    tui.setup.mockInput.pressEnter()
    const pinned = await waitFrame(tui, (f) => f.includes("notes.md 28"), 100)
    expect(pinned).toContain("pinned notes.md")
    expect(pinned).toContain("rules file")
    expect(pinned).toContain("quality bar")
    await tui.setup.mockInput.typeText(":context")
    tui.setup.mockInput.pressEnter()
    const menu = await waitFrame(tui, (f) => f.includes("context — what the model sees"))
    expect(menu).toContain("notes.md 28")
    expect(menu).toContain("preview")
    expect(menu).toContain("budget")
    await settle()
    tui.setup.mockInput.pressEscape()
    await waitFrame(tui, (f) => !f.includes("context — what the model sees"))
    await tui.setup.mockInput.typeText(":context drop 1")
    tui.setup.mockInput.pressEnter()
    const dropped = await waitFrame(tui, (f) => f.includes("dropped notes.md"), 100)
    expect(dropped).toContain("no pins")
  }, 20_000)

  test(":context off/on switches a standing source and the dashboard says so", async () => {
    const tui = await boot()
    await waitFrame(tui, (f) => f.includes("forge lessons"))
    await tui.setup.mockInput.typeText(":context off lessons")
    tui.setup.mockInput.pressEnter()
    const off = await waitFrame(tui, (f) => f.includes("forge lessons off"), 100)
    expect(off).toContain("forge lessons off")
    await tui.setup.mockInput.typeText(":context on lessons")
    tui.setup.mockInput.pressEnter()
    const on = await waitFrame(tui, (f) => !f.includes("forge lessons off"), 100)
    expect(on).not.toContain("forge lessons off")
  }, 20_000)

  test("a refine turn carries the pins once; the pane records the handoff; a later pin rides the next turn", async () => {
    const prompts: string[] = []
    const proposing = proposingRefineAgent({
      goal: "Create out.txt containing done.",
      acceptance: ["out.txt exists"],
      checks: [{ name: "out-exists", command: "test -f out.txt" }],
    })
    const tui = await boot({
      // A stalled title service must never hold the turn registration or
      // strand the next prompt after the first turn's queue drain.
      titleCompletion: Effect.never,
      seams: {
        refineAgent: (cid, prompt, tools) => {
          prompts.push(prompt)
          return proposing(cid, prompt, tools)
        },
      },
    })
    writeFileSync(join(tui.cwd, "notes.md"), "keep the API stable\n")
    await waitFrame(tui, (f) => f.includes("no pins"))
    await tui.setup.mockInput.typeText(":context add notes.md")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("pinned notes.md"), 100)
    await tui.setup.mockInput.typeText("make an out file")
    tui.setup.mockInput.pressEnter()
    const turn = await waitFrame(tui, (f) => f.includes("context → notes.md"), 400)
    expect(turn).toContain("handed to the model")
    expect(prompts[0]).toContain("## Context selected by the human")
    expect(prompts[0]).toContain("keep the API stable")
    // Context is published before the turn settles. This assertion concerns
    // the next turn, not the separate mid-turn steering path.
    await waitFrame(tui, () => !tui.store.busy(), 400)
    expect(tui.store.busy()).toBe(false)
    await tui.setup.mockInput.typeText("shorter")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, () => prompts.length === 2 && !tui.store.busy(), 400)
    expect(prompts[1]).toBe("shorter")
    expect(tui.store.busy()).toBe(false)
    await tui.setup.mockInput.typeText(":context add note: no new deps")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("pinned note: no new deps"), 100)
    await tui.setup.mockInput.typeText("and tests")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, () => prompts.length === 3, 400)
    expect(prompts[2]).toContain("no new deps")
    expect(prompts[2]).toContain("keep the API stable")
  }, 40_000)

  test(":context show previews without a turn; the dashboard cursor reaches a pin's verbs", async () => {
    const tui = await boot()
    writeFileSync(join(tui.cwd, "notes.md"), "hi\n")
    await waitFrame(tui, (f) => f.includes("no pins"))
    await tui.setup.mockInput.typeText(":context add notes.md")
    tui.setup.mockInput.pressEnter()
    await waitFrame(tui, (f) => f.includes("pinned notes.md"), 100)
    await tui.setup.mockInput.typeText(":context show")
    tui.setup.mockInput.pressEnter()
    const preview = await waitFrame(tui, (f) => f.includes("context preview: notes.md 3"), 100)
    expect(preview).toContain("context preview")
    // No specs, runs, or sessions: the four standing rows come first, the pin fifth.
    tui.setup.mockInput.pressTab()
    await waitFrame(tui, (f) => f.includes("> ✓ rules file"))
    await settle()
    tui.setup.mockInput.pressArrow("down")
    await settle()
    tui.setup.mockInput.pressArrow("down")
    await settle()
    tui.setup.mockInput.pressArrow("down")
    await settle()
    tui.setup.mockInput.pressArrow("down")
    const onPin = await waitFrame(tui, (f) => f.includes("> · notes.md 3"))
    expect(onPin).toContain("> · notes.md 3")
    await settle()
    tui.setup.mockInput.pressEnter()
    const verbs = await waitFrame(tui, (f) => f.includes("pin — notes.md 3"))
    expect(verbs).toContain("switch off")
    expect(verbs).toContain("remove")
    await tui.setup.mockInput.typeText("remove")
    await settle()
    tui.setup.mockInput.pressEnter()
    const gone = await waitFrame(tui, (f) => f.includes("dropped notes.md"), 100)
    expect(gone).toContain("no pins")
  }, 20_000)
})
