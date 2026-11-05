import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { ConversationId, SessionChannel } from "@xandreed/core"
import { sessionChannelConformance } from "@xandreed/core/conformance"
import { sessionChannelDefaults } from "./session-channel.entity.js"
import { makeMemorySessionChannel, SessionChannelMemoryLive } from "./session-channel.memory.adapter.js"

const capacity = 8

describe("SessionChannelMemoryLive", () => {
  sessionChannelConformance({
    open: () => makeMemorySessionChannel({ capacity }).pipe(Effect.map(({ channel, retained }) => ({ channel, capacity, retained }))),
  }).forEach((check) => test(check.name, () => Effect.runPromise(check.run)))

  test("keeps 256 payloads per follower by default and refuses a capacity it cannot hold", async () => {
    expect(sessionChannelDefaults).toEqual({ capacity: 256 })
    const built = (options: { readonly capacity?: number }) => Effect.runPromiseExit(Effect.scoped(Layer.build(SessionChannelMemoryLive(options))))
    expect(Exit.isSuccess(await built({}))).toBe(true)
    const refused = await built({ capacity: 0 })
    expect(Exit.isFailure(refused) && Cause.hasDies(refused.cause)).toBe(true)
  })

  test("a publish to a session nobody follows keeps nothing", async () => {
    const held = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { channel, retained } = yield* makeMemorySessionChannel()
      const id = ConversationId.make("00000000-0000-4000-8000-0000000000c2")
      yield* Effect.forEach([1, 2, 3], (n) => channel.publish({ id, owner: "owner-1" }, { event: "app.preview", data: { n } }), { concurrency: 1, discard: true })
      return yield* retained
    })))
    expect(held).toBe(0)
    expect(SessionChannel.key).toBe("@xandreed/core/SessionChannel")
  })
})
