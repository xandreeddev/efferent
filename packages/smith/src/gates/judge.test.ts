import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Metric, Option, Schema, TestClock, TestContext } from "effect"
import { Spec, WorkspacePath } from "@xandreed/foundry"
import type { Workspace } from "@xandreed/foundry"
import { extractVerdictJson, gatherEvidence, judgePrompt, makeSmithJudgeGate } from "./judge.js"

const spec = Effect.runSync(
  Schema.decodeUnknown(Spec)({
    goal: "port stats.py",
    acceptance: ["bun test exits 0"],
    limits: { maxAttempts: 3, budgetMillis: 1000 },
  }),
)

const ws = (rootDir: string, files: ReadonlyArray<string>): Workspace => ({
  rootDir,
  files: files.map((f) => WorkspacePath.make(f)),
})

describe("extractVerdictJson", () => {
  test("finds the LAST balanced verdict after prose (braces in reasons survive)", () => {
    const reply = `Reasoning: the code {looks} fine but the test asserts {"sound": "no"} weirdly.
Final answer:
{"sound": false, "reasons": ["stubbed {impl} in stats.ts", "check gamed"]}`
    const raw = Option.getOrThrow(extractVerdictJson(reply))
    expect(JSON.parse(raw)).toEqual({
      sound: false,
      reasons: ["stubbed {impl} in stats.ts", "check gamed"],
    })
    expect(Option.getOrThrow(extractVerdictJson('{"sound": true}'))).toBe('{"sound": true}')
    expect(Option.isNone(extractVerdictJson("I refuse to answer in JSON"))).toBe(true)
    expect(Option.isNone(extractVerdictJson('{"sound": true'))).toBe(true)
  })
})

describe("gatherEvidence", () => {
  test("bounded source contents; excluded trees never leak", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-ev-"))
    writeFileSync(join(dir, "a.ts"), "export const a = 1")
    writeFileSync(join(dir, "secret.bin"), "BINARY")
    const evidence = await Effect.runPromise(
      gatherEvidence(
        ws(dir, ["a.ts", "secret.bin", "node_modules/x/index.ts", ".foundry/runs/r.json"]),
      ),
    )
    expect(evidence).toContain("=== a.ts ===")
    expect(evidence).toContain("export const a = 1")
    expect(evidence).not.toContain("node_modules")
    expect(evidence).not.toContain(".foundry")
    expect(evidence).not.toContain("BINARY")
    // The prompt embeds goal + acceptance + evidence.
    const prompt = judgePrompt(spec, Option.none(), evidence)
    expect(prompt).toContain("port stats.py")
    expect(prompt).toContain("bun test exits 0")
    expect(prompt).toContain('{"sound"')
  })

  test("hidden-dir infrastructure never floods the evidence; the deliverable is visible AND readable", async () => {
    // The zig-run failure class: ~15k .local/zig stdlib paths filled the
    // 400-line list, zig/ fell off, and the judge asserted it didn't exist.
    const dir = mkdtempSync(join(tmpdir(), "judge-ev-"))
    mkdirSync(join(dir, "zig", "src"), { recursive: true })
    writeFileSync(join(dir, "zig", "src", "main.zig"), "pub fn main() !void {}")
    mkdirSync(join(dir, ".local", "zig", "lib"), { recursive: true })
    writeFileSync(join(dir, ".local", "zig", "lib", "std.zig"), "// toolchain")
    writeFileSync(join(dir, ".gitignore"), "zig-out/")
    const evidence = await Effect.runPromise(
      gatherEvidence(
        ws(dir, ["zig/src/main.zig", ".local/zig/lib/std.zig", ".gitignore"]),
      ),
    )
    // The toolchain is invisible; the port is listed and its CONTENT is
    // readable (zig is a source extension now); hidden FILES stay visible.
    expect(evidence).not.toContain(".local/")
    expect(evidence).toContain("zig/src/main.zig")
    expect(evidence).toContain("pub fn main() !void {}")
    expect(evidence).toContain(".gitignore")
  })

  test("a clipped file list SAYS so — absence must not read as nonexistence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-ev-"))
    const files = Array.from({ length: 405 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`)
    files.forEach((name) => writeFileSync(join(dir, name), "x"))
    const evidence = await Effect.runPromise(gatherEvidence(ws(dir, files)))
    expect(evidence).toContain("405 total")
    expect(evidence).toContain("5 more exist but are NOT shown")
    expect(evidence).toContain("absence from this list proves nothing")
  })
})

describe("judgePrompt — the standing contract", () => {
  test("doctrine renders between the spec and the evidence; None leaves the prompt unchanged", () => {
    const doctrine =
      "## Standing quality contract (deterministic rules armed in this workspace)\n- effect/no-let: `let` and `var` are banned\n\nThese rules are enforced by earlier gates — do NOT re-litigate style."
    const withBar = judgePrompt(spec, Option.none(), "EVIDENCE", Option.some(doctrine))
    expect(withBar).toContain("Standing quality contract")
    expect(withBar.indexOf("port stats.py")).toBeLessThan(
      withBar.indexOf("Standing quality contract"),
    )
    expect(withBar.indexOf("Standing quality contract")).toBeLessThan(
      withBar.indexOf("WORKSPACE EVIDENCE"),
    )
    const without = judgePrompt(spec, Option.none(), "EVIDENCE")
    expect(without).not.toContain("Standing quality contract")
  })
})

describe("makeSmithJudgeGate", () => {
  const workspace = ws(mkdtempSync(join(tmpdir(), "judge-ws-")), [])

  test("sound → no findings; unsound → one error finding per reason", async () => {
    const sound = makeSmithJudgeGate({
      spec,
      doc: Option.none(),
      call: () => Effect.succeed('Looks legitimate.\n{"sound": true}'),
    })
    expect(await Effect.runPromise(sound.run(workspace))).toEqual([])
    expect(sound.kind).toBe("judge")
    expect(sound.deterministic).toBe(false)

    const unsound = makeSmithJudgeGate({
      spec,
      doc: Option.none(),
      call: () =>
        Effect.succeed('Reasoning...\n{"sound": false, "reasons": ["stats.ts is a stub"]}'),
    })
    const findings = await Effect.runPromise(unsound.run(workspace))
    expect(findings).toHaveLength(1)
    expect(findings[0]?.message).toBe("stats.ts is a stub")
    expect(findings[0]?.severity).toBe("error")
  })

  // The judge RETRIES crashes on a spaced schedule (task #110) — crash-path
  // tests drive the TestClock past the retry windows instead of sleeping.
  const crashExit = (gate: { readonly run: (ws: Workspace) => Effect.Effect<unknown, unknown> }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.exit(gate.run(workspace)))
        yield* TestClock.adjust("60 seconds")
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestContext.TestContext)),
    )

  test("FAIL-CLOSED: no verdict / undecodable / model failure are all GateCrash", async () => {
    const cases = [
      makeSmithJudgeGate({ spec, doc: Option.none(), call: () => Effect.succeed("no json here") }),
      makeSmithJudgeGate({
        spec,
        doc: Option.none(),
        call: () => Effect.succeed('{"sound": "definitely"}'),
      }),
      makeSmithJudgeGate({ spec, doc: Option.none(), call: () => Effect.fail("provider down") }),
    ]
    const exits = await Promise.all(cases.map(crashExit))
    exits.forEach((exit) => {
      const tagged = exit as { readonly _tag: string }
      expect(tagged._tag).toBe("Failure")
      expect(String(exit)).toContain("GateCrash")
    })
  })

  test("verdicts move the smith.judge.verdicts counter by outcome", async () => {
    const counter = (verdict: string) =>
      Effect.runPromise(
        Metric.value(
          Metric.tagged(
            Metric.counter("smith.judge.verdicts", {
              description: "judge gate verdicts by outcome",
              incremental: true,
            }),
            "verdict",
            verdict,
          ),
        ),
      ).then((state) => state.count)
    const before = await counter("unsound")
    const beforeCrash = await counter("crash")
    const gate = makeSmithJudgeGate({
      spec,
      doc: Option.none(),
      call: () => Effect.succeed('{"sound": false, "reasons": ["hardcoded output"]}'),
    })
    const findings = await Effect.runPromise(gate.run(workspace))
    expect(findings).toHaveLength(1)
    expect((await counter("unsound")) - before).toBe(1)
    // A crash counts too — a frequently-crashing fail-closed judge is signal.
    // (Three retried calls = three crash increments; the retry itself is the
    // #110 behavior under test elsewhere.)
    const crashing = makeSmithJudgeGate({
      spec,
      doc: Option.none(),
      call: () => Effect.fail("provider down"),
    })
    await crashExit(crashing)
    expect((await counter("crash")) - beforeCrash).toBe(3)
  })
})
