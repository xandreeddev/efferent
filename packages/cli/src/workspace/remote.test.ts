import { describe, expect, test } from "bun:test"
import { Chunk, Effect, Stream } from "effect"
import { conversationSessionId } from "@xandreed/sdk-core"
import { makeRemoteWorkspace } from "./remote.js"
import { FAKE_ROOT_CID, fakeServerLive } from "./fakeAppEnv.js"

// The remote adapter, end-to-end: build a remote Workspace against a real
// loopback daemon (fakeServerLive provides the pre-pointed HttpClient), and
// drive a turn through it — proving client -> HTTP/SSE -> server -> in-process.

describe("remote Workspace adapter", () => {
  test("a remote Workspace drives a turn over the wire like the in-process one", async () => {
    const rootId = conversationSessionId(FAKE_ROOT_CID as never)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        // baseUrl "" — the layerTest HttpClient already prepends the server URL.
        const ws = yield* makeRemoteWorkspace("")
        const snap = yield* ws.snapshot()
        yield* ws.send(rootId, "remote drive")
        const events = yield* ws
          .subscribe(rootId, 0)
          .pipe(
            Stream.takeUntil((e) => e.event.type === "agent_end"),
            Stream.runCollect,
            Effect.timeout("8 seconds"),
          )
        const state = yield* ws.getState(rootId)
        return {
          kinds: snap.sessions.map((s) => s.kind),
          types: Chunk.toReadonlyArray(events).map((e) => e.event.type),
          busy: state.busy,
        }
      }).pipe(Effect.scoped, Effect.provide(fakeServerLive(FAKE_ROOT_CID, "remote ok"))),
    )
    expect(result.kinds).toContain("root")
    expect(result.types).toContain("turn_start")
    expect(result.types).toContain("agent_end")
    expect(result.busy).toBe(false)
  })

  test("directive set/get round-trips through the remote adapter", async () => {
    const directive = await Effect.runPromise(
      Effect.gen(function* () {
        const ws = yield* makeRemoteWorkspace("")
        yield* ws.setDirective({ objective: "remote goal" })
        return yield* ws.getDirective()
      }).pipe(Effect.scoped, Effect.provide(fakeServerLive(FAKE_ROOT_CID))),
    )
    expect(directive?.objective).toBe("remote goal")
  })
})
