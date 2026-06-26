import { join } from "node:path"
import { Effect } from "effect"
import { probeHealth } from "../server/attach.js"
import { check, expect, fail, skip } from "./check.js"
import type { CheckResult } from "./report.js"
import type { Runner } from "./runner.js"
import type { VerifyCtx } from "./context.js"

/**
 * Tier A — deterministic, no key, never flaky. Formalises run.sh's boot/gate
 * checks against the typed `Runner`, adds the **UI-flow** tier (the testRender
 * bun tests, run via `bun test`) and the daemon lifecycle (black-box via the
 * CLI's own `daemon status` + a `/health` probe). All hermetic.
 */

const PORT_RE = /127\.0\.0\.1:(\d+)/

export const runTierA = (runner: Runner, ctx: VerifyCtx): Effect.Effect<ReadonlyArray<CheckResult>> =>
  Effect.gen(function* () {
    const results: CheckResult[] = []
    const ws = runner.workspaceDir

    // ── boot ────────────────────────────────────────────────────────────────
    results.push(
      yield* check("boot:version", "A", Effect.gen(function* () {
        const r = yield* runner.invoke(["--version"])
        const v = r.stdout.trim()
        return expect(r.exitCode === 0 && /\d+\.\d+\.\d+/.test(v), `version ${v || "?"}`)
      })),
    )

    results.push(
      yield* check("boot:help-subcommands", "A", Effect.gen(function* () {
        const r = yield* runner.invoke(["--help"])
        const want = ["code", "attach", "daemon", "verify", "eval"]
        const missing = want.filter((w) => !r.stdout.includes(w))
        return expect(missing.length === 0, missing.length ? `missing: ${missing.join(",")}` : "lists code/attach/daemon/verify/eval")
      })),
    )

    results.push(
      yield* check("boot:subcommands-parse", "A", Effect.gen(function* () {
        const subs = ["code", "attach", "daemon", "verify", "eval"]
        const bad: string[] = []
        for (const s of subs) {
          const r = yield* runner.invoke([s, "--help"])
          if (r.exitCode !== 0) bad.push(s)
        }
        return expect(bad.length === 0, bad.length ? `failed to parse: ${bad.join(",")}` : "all sub-helps resolve")
      })),
    )

    // ── gate (no creds → graceful, not a crash) ──────────────────────────────
    results.push(
      yield* check("gate:no-provider-hint", "A", Effect.gen(function* () {
        const emptyHome = join(runner.homeDir, "gate-empty")
        const r = yield* runner.invoke(["--mode", "json", "ping"], {
          env: { EFFERENT_HOME: emptyHome },
          timeoutMs: 30_000,
        })
        const out = `${r.stdout}\n${r.stderr}`.toLowerCase()
        return expect(
          r.exitCode !== 0 && out.includes("no provider configured"),
          `exit ${r.exitCode}, hint ${out.includes("no provider configured") ? "shown" : "missing"}`,
        )
      })),
    )

    // ── ui-flows (testRender bun tests) ──────────────────────────────────────
    results.push(
      yield* check("ui-flows", "A", Effect.gen(function* () {
        const root = ctx.repoRoot
        if (!runner.supportsInProcess || root === undefined) {
          return skip("n/a — needs a source checkout")
        }
        const r = yield* Effect.tryPromise(async () => {
          const proc = Bun.spawn(
            [process.execPath, "test", "packages/cli/src/cli/verify-flows/"],
            { cwd: root, stdout: "pipe", stderr: "pipe" },
          )
          const [stderr, exitCode] = await Promise.all([
            new Response(proc.stderr).text(),
            proc.exited,
          ])
          return { stderr, exitCode }
        }).pipe(Effect.orElseSucceed(() => ({ stderr: "spawn failed", exitCode: 1 })))
        // bun:test prints the pass/fail summary on stderr.
        const summary = (r.stderr.match(/\d+ pass|\d+ fail/g) ?? []).join(" ")
        return expect(r.exitCode === 0, summary || `bun test exit ${r.exitCode}`)
      })),
    )

    // ── daemon lifecycle (start → healthy → /health → stop) ───────────────────
    results.push(
      yield* check("daemon:lifecycle", "A", Effect.gen(function* () {
        const home = join(runner.homeDir, "daemon")
        const env = { EFFERENT_HOME: home }
        const bg = yield* runner.spawnBg(["daemon", "start", "--cwd", ws], { env })
        const out = yield* pollDaemon(runner, ws, env, 30)
        if (out.port === undefined) {
          yield* Effect.sync(() => bg.kill())
          return fail("daemon did not become healthy within timeout")
        }
        const baseUrl = `http://127.0.0.1:${out.port}`
        const healthy = yield* probeHealth(baseUrl)
        yield* runner.invoke(["daemon", "stop", "--cwd", ws], { env })
        yield* Effect.sleep("300 millis")
        yield* Effect.sync(() => bg.kill())
        return expect(healthy, `healthy on :${out.port}, GET /health ${healthy ? "200" : "unreachable"}`)
      })),
    )

    return results
  })

/** Poll `daemon status` until it reports healthy + a port, or attempts run out. */
const pollDaemon = (
  runner: Runner,
  ws: string,
  env: Record<string, string>,
  attempts: number,
): Effect.Effect<{ readonly port: number | undefined }> =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      const r = yield* runner.invoke(["daemon", "status", "--cwd", ws], { env, timeoutMs: 10_000 })
      if (/healthy/i.test(r.stdout)) {
        const m = PORT_RE.exec(r.stdout)
        return { port: m ? Number(m[1]) : undefined }
      }
      yield* Effect.sleep("500 millis")
    }
    return { port: undefined }
  })
