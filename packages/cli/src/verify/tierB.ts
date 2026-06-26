import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FetchHttpClient } from "@effect/platform"
import { Effect } from "effect"
import type { CreateFleetRequest, SessionId } from "@xandreed/sdk-core"
import { makeHttpTransport } from "../transport/http/client.js"
import { check, expect, skip, type CheckOutcome } from "./check.js"
import { parseJsonlEvents, parseRpcLines, rpcResultFor, usedToolOk } from "./parse.js"
import type { CheckResult } from "./report.js"
import type { Runner } from "./runner.js"
import type { VerifyCtx } from "./context.js"

/**
 * Tier B — LLM-as-agent, objective assertion, on the cheap model. Every check
 * asserts a real **side-effect** (a file on disk + a successful tool call),
 * never prose, so a chatty model can't pass and a terse one can't fail. The
 * model is pinned via a local `.efferent/config.json` (local-over-global, so a
 * user's global `/model` pin can't override it) AND `EFFERENT_MODEL`. Skips
 * cleanly with no credential. One whole-turn retry absorbs a transient LLM blip.
 */

const WRITE_TOOLS = ["write_file", "edit_file", "Bash"]

/** Pin the cheap model in the temp workspace + isolate history. */
const keyedEnv = (runner: Runner, model: string): Record<string, string> => {
  const dir = join(runner.workspaceDir, ".efferent")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "config.json"), JSON.stringify({ model }), "utf8")
  return {
    EFFERENT_MODEL: model,
    EFFERENT_DB_URL: join(runner.homeDir, "verify-history.db"),
  }
}

const fileHas = (path: string, needle: string): boolean => {
  try {
    return existsSync(path) && readFileSync(path, "utf8").includes(needle)
  } catch {
    return false
  }
}

/** Run a turn body up to twice — the second attempt absorbs a transient LLM blip. */
const withRetry = (body: Effect.Effect<CheckOutcome>): Effect.Effect<CheckOutcome> =>
  Effect.gen(function* () {
    const first = yield* body
    if (first.status === "pass") return first
    return yield* body
  })

export const runTierB = (runner: Runner, ctx: VerifyCtx): Effect.Effect<ReadonlyArray<CheckResult>> =>
  Effect.gen(function* () {
    if (!ctx.hasKey) {
      return [
        yield* check("code-turn", "B", Effect.succeed(skip("no credential — log in via :login"))),
        yield* check("daemon-turn", "B", Effect.succeed(skip("no credential"))),
        yield* check("rpc-turn", "B", Effect.succeed(skip("no credential"))),
      ]
    }

    const ws = runner.workspaceDir
    const env = keyedEnv(runner, ctx.model)
    const results: CheckResult[] = []

    // ── code-turn: in-process json, assert the file + a write tool ───────────
    results.push(
      yield* check("code-turn", "B", withRetry(Effect.gen(function* () {
        const proof = join(ws, "proof.txt")
        yield* Effect.sync(() => { if (existsSync(proof)) writeFileSync(proof, "", "utf8") })
        const r = yield* runner.invoke(
          ["--cwd", ws, "--allow-bash", "--mode", "json",
            "Create a file named proof.txt containing exactly: efferent verify ok — then run 'cat proof.txt'."],
          { env, timeoutMs: 150_000 },
        )
        const events = parseJsonlEvents(r.stdout)
        const tools = usedToolOk(events, WRITE_TOOLS)
        const wrote = fileHas(proof, "efferent verify ok")
        return expect(wrote && tools, wrote && tools ? "wrote proof.txt via a tool" : `file ${wrote ? "ok" : "missing"}, write-tool ${tools ? "ok" : "absent"}`)
      }))),
    )

    // ── daemon-turn: route a task through the running daemon over HTTP ────────
    results.push(
      yield* check("daemon-turn", "B", withRetry(Effect.gen(function* () {
        const proof = join(ws, "daemon-proof.txt")
        yield* Effect.sync(() => { if (existsSync(proof)) writeFileSync(proof, "", "utf8") })
        const bg = yield* runner.spawnBg(["daemon", "start", "--cwd", ws, "--allow-bash"], { env })
        const outcome = yield* daemonTurn(runner, ws, env, proof, ctx.model).pipe(
          Effect.ensuring(Effect.gen(function* () {
            yield* runner.invoke(["daemon", "stop", "--cwd", ws], { env })
            yield* Effect.sleep("300 millis")
            yield* Effect.sync(() => bg.kill())
          })),
        )
        return outcome
      }))),
    )

    // ── rpc-turn: hold a session open, send one turn, assert the file ────────
    results.push(
      yield* check("rpc-turn", "B", withRetry(Effect.gen(function* () {
        const proof = join(ws, "rpc-proof.txt")
        yield* Effect.sync(() => { if (existsSync(proof)) writeFileSync(proof, "", "utf8") })
        const bg = yield* runner.spawnBg(["--cwd", ws, "--allow-bash", "--mode", "rpc"], { env })
        const req = JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "agent.send",
          params: { prompt: "Create a file named rpc-proof.txt containing exactly: efferent rpc ok." },
        }) + "\n"
        yield* Effect.sync(() => bg.write(req))
        let done = false
        for (let i = 0; i < 75 && !done; i++) {
          yield* Effect.sleep("2 seconds")
          const parsed = parseRpcLines(bg.output())
          if (rpcResultFor(parsed, 1) !== undefined) done = true
        }
        yield* Effect.sync(() => bg.kill())
        const wrote = fileHas(proof, "efferent rpc ok")
        return expect(done && wrote, done ? (wrote ? "rpc turn wrote the file" : "rpc resolved but no file") : "rpc turn did not resolve in time")
      }))),
    )

    return results
  })

/** Spawn a session on the daemon + poll it to completion, asserting the file. */
const daemonTurn = (
  runner: Runner,
  ws: string,
  env: Record<string, string>,
  proof: string,
  model: string,
): Effect.Effect<CheckOutcome> =>
  Effect.gen(function* () {
    // Wait for the daemon to register + report a port.
    let port: number | undefined
    for (let i = 0; i < 40 && port === undefined; i++) {
      const r = yield* runner.invoke(["daemon", "status", "--cwd", ws], { env, timeoutMs: 10_000 })
      const m = /127\.0\.0\.1:(\d+)/.exec(r.stdout)
      if (/healthy/i.test(r.stdout) && m) port = Number(m[1])
      else yield* Effect.sleep("500 millis")
    }
    if (port === undefined) return expect(false, "daemon did not become healthy")

    const transport = makeHttpTransport(`http://127.0.0.1:${port}`)
    // Create a FLEET (not a scoped sub-agent): the fleet's root is a direct coder
    // with the full toolkit, and a fleet created with a `task` runs it at once —
    // the same reliable write path the in-process turn takes.
    const req: CreateFleetRequest = {
      folder: ws,
      task: "Create a file named daemon-proof.txt containing exactly: efferent daemon ok",
      model,
    }
    const sid = yield* transport.createFleet(req).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.option,
    )
    if (sid._tag === "None") return expect(false, "POST /fleets failed")

    let settled = false
    for (let i = 0; i < 60 && !settled; i++) {
      yield* Effect.sleep("2 seconds")
      const state = yield* transport.getState(sid.value as SessionId).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.option,
      )
      if (state._tag === "Some" && state.value.busy === false) settled = true
    }
    const wrote = fileHas(proof, "efferent daemon ok")
    return expect(settled && wrote, settled ? (wrote ? "daemon turn wrote the file" : "settled but no file") : "daemon turn did not settle")
  })
