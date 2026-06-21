import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { ApprovalAllowAllLive } from "@xandreed/sdk-core"
import { makeInProcessWorkspace } from "../workspace/inProcess.js"
import { makeFleetSupervisor } from "../cli/state/fleet.js"
import { fakeAuthStore, fakeEnvLayers, fakeRootScope, FAKE_ROOT_CID } from "../workspace/fakeAppEnv.js"
import { serveWorkspaceProgram } from "./daemon.js"
import { attachOrSpawn, probeHealth } from "./attach.js"
import { readDiscovery } from "./discovery.js"

describe("attach-or-spawn", () => {
  let prev: string | undefined
  beforeAll(() => {
    prev = process.env.EFFERENT_HOME
    process.env.EFFERENT_HOME = mkdtempSync(join(tmpdir(), "eff-attach-"))
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.EFFERENT_HOME
    else process.env.EFFERENT_HOME = prev
  })

  test("spawns (in-process) when absent, then attaches to a healthy daemon", async () => {
    const workspace = "/tmp/ws-attach"
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ws = yield* makeInProcessWorkspace({
          roots: [{ cid: FAKE_ROOT_CID as never }],
          rootScope: fakeRootScope,
          cwd: workspace,
          skills: [],
          agents: [],
          tools: [],
          instructionFiles: [],
          approvalLayer: ApprovalAllowAllLive,
          fleet: makeFleetSupervisor(),
        })
        // The injected "spawn" starts a real in-process daemon (no subprocess),
        // capturing its fiber so we can stop it after the assertions.
        let daemonFiber: Fiber.RuntimeFiber<void, never> | undefined
        const spawnDaemon = () =>
          Effect.forkDaemon(
            serveWorkspaceProgram(ws, { workspace, version: "test" }).pipe(
              Effect.provide(fakeAuthStore),
            ),
          ).pipe(
            Effect.tap((f) => Effect.sync(() => { daemonFiber = f })),
            Effect.asVoid,
          )

        const attached = yield* attachOrSpawn(workspace, {
          spawnDaemon,
          pollMs: 50,
          timeoutMs: 8000,
        })
        // The attachment points at a live daemon — health is green.
        const healthy = yield* probeHealth(attached.baseUrl)
        if (daemonFiber !== undefined) yield* Fiber.interrupt(daemonFiber)
        return { baseUrl: attached.baseUrl, healthy }
      }).pipe(Effect.scoped, Effect.provide(fakeEnvLayers(FAKE_ROOT_CID))),
    )
    expect(result.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(result.healthy).toBe(true)
  })

  test("a missing workspace dir fails with a clear typed error (not a spawn defect)", async () => {
    const missing = join(tmpdir(), "eff-does-not-exist-zzz")
    const exit = await Effect.runPromiseExit(
      // No injected spawn → the real detached-spawn guard applies.
      attachOrSpawn(missing).pipe(Effect.scoped, Effect.provide(fakeEnvLayers(FAKE_ROOT_CID))),
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("workspace directory does not exist")
    }
  })

  test("a second attach reuses the already-running daemon (no re-spawn)", async () => {
    const workspace = "/tmp/ws-attach-2"
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ws = yield* makeInProcessWorkspace({
          roots: [{ cid: FAKE_ROOT_CID as never }],
          rootScope: fakeRootScope,
          cwd: workspace,
          skills: [],
          agents: [],
          tools: [],
          instructionFiles: [],
          approvalLayer: ApprovalAllowAllLive,
          fleet: makeFleetSupervisor(),
        })
        yield* Effect.forkScoped(
          serveWorkspaceProgram(ws, { workspace, version: "test" }).pipe(
            Effect.provide(fakeAuthStore),
          ),
        )
        // Wait until the daemon is registered + healthy BEFORE attaching, so the
        // reuse path (not the spawn path) is what's under test.
        let spawnCalls = 0
        const spawnDaemon = () => Effect.sync(() => { spawnCalls += 1 })
        let up = false
        let spins = 0
        while (!up && spins < 200) {
          yield* Effect.sleep("20 millis")
          const info = yield* readDiscovery(workspace)
          up = info !== undefined && (yield* probeHealth(`http://127.0.0.1:${info.port}`))
          spins += 1
        }
        const first = yield* attachOrSpawn(workspace, { spawnDaemon, pollMs: 50, timeoutMs: 8000 })
        const second = yield* attachOrSpawn(workspace, { spawnDaemon, pollMs: 50, timeoutMs: 8000 })
        return { sameUrl: first.baseUrl === second.baseUrl, spawnCalls }
      }).pipe(Effect.scoped, Effect.provide(fakeEnvLayers(FAKE_ROOT_CID))),
    )
    // Both attaches found the running daemon; the injected spawn was never used.
    expect(result.sameUrl).toBe(true)
    expect(result.spawnCalls).toBe(0)
  })
})
