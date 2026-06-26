import { describe, expect, test } from "bun:test"
import { Chunk, Effect, Fiber, Stream } from "effect"
import { conversationSessionId } from "@xandreed/sdk-core"
import { makeHttpTransport } from "./client.js"
import { FAKE_ROOT_CID, fakeServerLive } from "../../workspace/fakeAppEnv.js"

// tmux-style fan-out: two independent SSE subscribers on ONE session both
// receive the full event stream of a single producer run. This is what lets two
// TUIs (or a TUI + a browser) watch & steer the same session at once.

describe("multi-client fan-out", () => {
  test("two subscribers on one session both receive the run's events to agent_end", async () => {
    const rootId = conversationSessionId(FAKE_ROOT_CID as never)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const t = makeHttpTransport("")
        const collect = () =>
          t
            .subscribe(rootId, 0)
            .pipe(
              Stream.takeUntil((e) => e.event.type === "agent_end"),
              Stream.runCollect,
              Effect.timeout("8 seconds"),
            )
        // Both subscribers attach first…
        const a = yield* Effect.fork(collect())
        const b = yield* Effect.fork(collect())
        yield* Effect.sleep("100 millis")
        // …then a single producer run is driven once.
        yield* t.send(rootId, "broadcast me")
        const ra = yield* Fiber.join(a)
        const rb = yield* Fiber.join(b)
        return {
          aTypes: Chunk.toReadonlyArray(ra).map((e) => e.event.type),
          bTypes: Chunk.toReadonlyArray(rb).map((e) => e.event.type),
        }
      }).pipe(Effect.scoped, Effect.provide(fakeServerLive(FAKE_ROOT_CID, "fan-out ok"))),
    )
    // Each client independently saw the same run end.
    expect(result.aTypes).toContain("agent_end")
    expect(result.bTypes).toContain("agent_end")
    expect(result.aTypes).toContain("turn_start")
    expect(result.bTypes).toContain("turn_start")
  })
})
