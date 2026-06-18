import { describe, expect, it } from "bun:test"
import { Effect, Fiber, Layer, Ref } from "effect"
import {
  Approval,
  DefaultSettings,
  SettingsStore,
  UtilityLlm,
  type ApprovalDecision,
  type Settings,
} from "@xandreed/sdk-core"
import { makeTuiApproval } from "./approval.js"
import type { TuiStore } from "./state/store.js"

const REQ = {
  tool: "Bash",
  summary: "ls -la src",
  cwd: "/work/repo",
  ruleKey: "cmd:ls",
} as const

/** The minimal TuiStore surface `makeTuiApproval` touches, with probes. */
const makeFakeStore = () => {
  let ov: { kind: string; state?: unknown } = { kind: "none" }
  const blocks: Array<{ kind: string; text: string }> = []
  let stats = { byRole: { main: 0, fast: 0 } }
  const store = {
    setOverlay: (o: { kind: string; state?: unknown }) => {
      ov = o
    },
    overlay: () => ov,
    closeOverlay: () => {
      ov = { kind: "none" }
    },
    pushBlock: (b: { kind: string; text: string }) => {
      blocks.push(b)
    },
    setStats: (fn: (s: typeof stats) => typeof stats) => {
      stats = fn(stats)
    },
  } as unknown as TuiStore
  return { store, blocks, overlay: () => ov, fastSpend: () => stats.byRole.fast }
}

const settingsLayer = (initial: Partial<Settings>) => {
  const ref = Ref.unsafeMake<Settings>({ ...DefaultSettings, ...initial })
  return {
    layer: Layer.succeed(
      SettingsStore,
      SettingsStore.of({
        get: () => Ref.get(ref),
        global: () => Ref.get(ref),
        update: (f) => Ref.updateAndGet(ref, f),
        load: () => Ref.get(ref),
      }),
    ),
    current: () => Ref.get(ref),
  }
}

const USAGE = { inputTokens: 150, outputTokens: 15, totalTokens: 165, cacheReadTokens: 0 }

/** A judge stub returning canned verdicts in order; records every prompt. */
const utilityLayer = (replies: ReadonlyArray<string>, prompts: string[] = []) => {
  let i = 0
  return Layer.succeed(UtilityLlm, {
    complete: (prompt: string) => {
      prompts.push(prompt)
      const text = replies[Math.min(i, replies.length - 1)] ?? `{"verdict":"prompt"}`
      i += 1
      return Effect.succeed({ text, usage: USAGE })
    },
  })
}

/** Park `request`, wait for the modal, answer it, return the decision. */
const askAndAnswer = (
  tui: ReturnType<typeof makeTuiApproval>,
  fake: ReturnType<typeof makeFakeStore>,
  request: Effect.Effect<ApprovalDecision>,
  answer: ApprovalDecision,
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(request)
    let spins = 0
    while (fake.overlay().kind !== "approval" && spins < 100) {
      yield* Effect.yieldNow()
      spins += 1
    }
    expect(fake.overlay().kind).toBe("approval")
    yield* Effect.sync(() => tui.resolve(answer))
    return yield* Fiber.join(fiber)
  })

describe("makeTuiApproval — fast auto-approval", () => {
  it("a judge allow skips the modal, counts FAST spend, and surfaces a notice", async () => {
    const fake = makeFakeStore()
    const tui = makeTuiApproval(fake.store)
    const settings = settingsLayer({})
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        const approval = yield* Approval
        return yield* approval.request(REQ)
      }).pipe(
        Effect.provide(tui.layer),
        Effect.provide(settings.layer),
        Effect.provide(utilityLayer([`{"verdict":"allow","reason":"listing inside workspace"}`])),
      ),
    )
    expect(decision).toEqual({ kind: "allow", scope: "once" })
    expect(fake.overlay().kind).toBe("none")
    expect(fake.fastSpend()).toBe(USAGE.inputTokens + USAGE.outputTokens)
    expect(fake.blocks).toEqual([
      { kind: "info", text: "fast approved: ls -la src — listing inside workspace" },
    ])
  })

  it("a prompt verdict opens the modal; a session allow grants the FOLDER, which feeds the next judgment", async () => {
    const fake = makeFakeStore()
    const tui = makeTuiApproval(fake.store)
    const settings = settingsLayer({})
    const prompts: string[] = []
    const judged = utilityLayer(
      [`{"verdict":"prompt","folder":"/etc","reason":"reads outside workspace"}`],
      prompts,
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const approval = yield* Approval
        const first = yield* askAndAnswer(
          tui,
          fake,
          approval.request({ ...REQ, summary: "cat /etc/hosts", ruleKey: "cmd:cat" }),
          { kind: "allow", scope: "session" },
        )
        expect(first).toEqual({ kind: "allow", scope: "session" })
        // Second request: different command, same folder — the judge's
        // permitted list now carries the granted /etc.
        yield* Effect.fork(
          approval.request({ ...REQ, summary: "ls /etc", ruleKey: "cmd:ls" }),
        )
        let spins = 0
        while (prompts.length < 2 && spins < 100) {
          yield* Effect.yieldNow()
          spins += 1
        }
        expect(prompts[1]).toContain("- /etc")
      }).pipe(Effect.provide(tui.layer), Effect.provide(settings.layer), Effect.provide(judged)),
    )
  })

  it("a project allow with a folder hint persists Settings.approvedFolders, not a bash rule", async () => {
    const fake = makeFakeStore()
    const tui = makeTuiApproval(fake.store)
    const settings = settingsLayer({})
    await Effect.runPromise(
      Effect.gen(function* () {
        const approval = yield* Approval
        yield* askAndAnswer(
          tui,
          fake,
          approval.request({ ...REQ, summary: "cat /etc/hosts", ruleKey: "cmd:cat" }),
          { kind: "allow", scope: "project" },
        )
      }).pipe(
        Effect.provide(tui.layer),
        Effect.provide(settings.layer),
        Effect.provide(utilityLayer([`{"verdict":"prompt","folder":"/etc","reason":"outside"}`])),
      ),
    )
    const persisted = await Effect.runPromise(settings.current())
    expect(persisted.approvedFolders).toEqual(["/etc"])
    expect(persisted.approvedBashRules).toBeUndefined()
  })

  it(":set autoApprove false goes straight to the modal — the judge is never consulted", async () => {
    const fake = makeFakeStore()
    const tui = makeTuiApproval(fake.store)
    const settings = settingsLayer({ autoApprove: false })
    const prompts: string[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const approval = yield* Approval
        const decision = yield* askAndAnswer(tui, fake, approval.request(REQ), {
          kind: "deny",
          reason: "not now",
        })
        expect(decision).toEqual({ kind: "deny", reason: "not now" })
      }).pipe(
        Effect.provide(tui.layer),
        Effect.provide(settings.layer),
        Effect.provide(utilityLayer([`{"verdict":"allow"}`], prompts)),
      ),
    )
    expect(prompts).toEqual([])
    expect(fake.fastSpend()).toBe(0)
  })

  it("an existing rule short-circuits before the judge", async () => {
    const fake = makeFakeStore()
    const tui = makeTuiApproval(fake.store)
    const settings = settingsLayer({ approvedBashRules: ["cmd:ls"] })
    const prompts: string[] = []
    const decision = await Effect.runPromise(
      Effect.gen(function* () {
        const approval = yield* Approval
        return yield* approval.request(REQ)
      }).pipe(
        Effect.provide(tui.layer),
        Effect.provide(settings.layer),
        Effect.provide(utilityLayer([`{"verdict":"prompt"}`], prompts)),
      ),
    )
    expect(decision).toEqual({ kind: "allow", scope: "once" })
    expect(prompts).toEqual([])
  })
})
