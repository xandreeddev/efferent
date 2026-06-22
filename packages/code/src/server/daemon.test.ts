import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import { makeInProcessWorkspace } from "../workspace/inProcess.js"
import { makeFleetSupervisor } from "../cli/state/fleet.js"
import { ApprovalAllowAllLive } from "@xandreed/sdk-core"
import { fakeEnvLayers, fakeRootScope, FAKE_ROOT_CID } from "../workspace/fakeAppEnv.js"
import { serveWorkspaceProgram } from "./daemon.js"
import { readDiscovery } from "./discovery.js"

describe("daemon serve", () => {
  let prev: string | undefined
  beforeAll(() => {
    prev = process.env.EFFERENT_HOME
    process.env.EFFERENT_HOME = mkdtempSync(join(tmpdir(), "eff-daemon-"))
  })
  afterAll(() => {
    if (prev === undefined) delete process.env.EFFERENT_HOME
    else process.env.EFFERENT_HOME = prev
  })

  test("serves /health on an ephemeral port, writes the discovery file, removes it on teardown", async () => {
    const workspace = "/tmp/ws-daemon-serve"
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const ws = yield* makeInProcessWorkspace({
          roots: [{ cid: FAKE_ROOT_CID as never }],
          rootScope: fakeRootScope,
          cwd: workspace,
          skills: [],
          memory: [],
          agents: [],
          tools: [],
          instructionFiles: [],
          approvalLayer: ApprovalAllowAllLive,
          fleet: makeFleetSupervisor(),
        })
        const fiber = yield* Effect.forkScoped(
          serveWorkspaceProgram(ws, { workspace, version: "test-version" }),
        )
        // Wait for the daemon to bind + publish its port.
        let info = yield* readDiscovery(workspace)
        let spins = 0
        while (info === undefined && spins < 300) {
          yield* Effect.sleep("20 millis")
          info = yield* readDiscovery(workspace)
          spins += 1
        }
        if (info === undefined) return { ok: false as const }
        const res = yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${info!.port}/health`),
        )
        const body = (yield* Effect.promise(() => res.json())) as {
          version: string
          workspace: string
        }
        yield* Fiber.interrupt(fiber)
        const after = yield* readDiscovery(workspace)
        return {
          ok: true as const,
          status: res.status,
          version: body.version,
          workspace: body.workspace,
          removedAfterTeardown: after === undefined,
        }
      }).pipe(Effect.scoped, Effect.provide(fakeEnvLayers(FAKE_ROOT_CID))),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe(200)
    expect(result.version).toBe("test-version")
    expect(result.workspace).toBe(workspace)
    expect(result.removedAfterTeardown).toBe(true)
  })

  test("POST /shutdown stops the daemon gracefully and removes the discovery file", async () => {
    const workspace = "/tmp/ws-daemon-shutdown"
    const removed = await Effect.runPromise(
      Effect.gen(function* () {
        const ws = yield* makeInProcessWorkspace({
          roots: [{ cid: FAKE_ROOT_CID as never }],
          rootScope: fakeRootScope,
          cwd: workspace,
          skills: [],
          memory: [],
          agents: [],
          tools: [],
          instructionFiles: [],
          approvalLayer: ApprovalAllowAllLive,
          fleet: makeFleetSupervisor(),
        })
        yield* Effect.forkScoped(serveWorkspaceProgram(ws, { workspace, version: "v" }))
        let info = yield* readDiscovery(workspace)
        let spins = 0
        while (info === undefined && spins < 300) {
          yield* Effect.sleep("20 millis")
          info = yield* readDiscovery(workspace)
          spins += 1
        }
        if (info === undefined) return false
        yield* Effect.promise(() =>
          fetch(`http://127.0.0.1:${info!.port}/shutdown`, { method: "POST" }),
        )
        // The daemon answers 204, then tears down ~100ms later → discovery gone.
        let after = yield* readDiscovery(workspace)
        let s2 = 0
        while (after !== undefined && s2 < 300) {
          yield* Effect.sleep("20 millis")
          after = yield* readDiscovery(workspace)
          s2 += 1
        }
        return after === undefined
      }).pipe(Effect.scoped, Effect.provide(fakeEnvLayers(FAKE_ROOT_CID))),
    )
    expect(removed).toBe(true)
  })
})
