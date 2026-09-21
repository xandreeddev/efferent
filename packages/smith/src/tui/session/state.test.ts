import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Option } from "effect"
import { ConversationId } from "@xandreed/core"
import type { SpecDoc } from "@xandreed/core"
import type { RefineSession } from "../../refine/session.js"
import {
  beginForge,
  beginRefine,
  currentSession,
  dropped,
  forgeEnded,
  forgeStarted,
  idle,
  interruptTarget,
  isRunning,
  modeOf,
  replayed,
  shipPlan,
  shipped,
  turnEnded,
  turnStarted,
} from "./state.js"

const fiber = () => Effect.runSync(Effect.forkDaemon(Effect.never))
const session = { conversationId: ConversationId.make("00000000-0000-4000-8000-000000000001") } as never
const doc = { slug: "x", status: "locked", goal: "g" } as never
const cid = ConversationId.make("00000000-0000-4000-8000-000000000002")
const plan = { cwd: "/ws", branch: "smith/x", subject: "s", commitBody: "b", prBody: "p" }

describe("the workspace session as one value", () => {
  test("mode is a projection: idle → refine → forge → forge → idle", () => {
    const refining = beginRefine(session)(idle)
    const forging = beginForge(doc)(refining)
    const forged = forgeEnded({ followUp: Option.some(cid), ship: Option.some(plan) })(forging)
    expect([idle, refining, forging, forged, dropped(forged)].map(modeOf)).toEqual([
      "idle",
      "refine",
      "forge",
      "forge",
      "idle",
    ])
    // The refine session rides through the forge — :lock and :branch still know it.
    expect(Option.isSome(currentSession(forged))).toBe(true)
    expect(Option.isSome(shipPlan(forged))).toBe(true)
    expect(Option.isNone(shipPlan(shipped(forged)))).toBe(true)
  })

  test("a turn registers itself and only ITS unregistration clears it — a stale fiber can never wedge the session", async () => {
    const a = fiber()
    const b = fiber()
    const refining = beginRefine(session)(idle)
    expect(isRunning(refining)).toBe(false)
    const withA = turnStarted(a)(refining)
    expect(isRunning(withA)).toBe(true)
    expect(Option.map(interruptTarget(withA), (t) => t.kind)).toEqual(Option.some("turn"))
    // Another fiber's ensuring does not clear A's registration.
    expect(isRunning(turnEnded(b)(withA))).toBe(true)
    expect(isRunning(turnEnded(a)(withA))).toBe(false)
    // Idle cannot host a turn: the registration is the identity.
    expect(turnStarted(a)(idle)).toEqual(idle)
    await Effect.runPromise(Fiber.interrupt(a))
    await Effect.runPromise(Fiber.interrupt(b))
  })

  test("Esc targets the turn before the forge; an idle dashboard has nothing to interrupt", async () => {
    const f = fiber()
    const forging = forgeStarted(f)(beginForge(doc)(idle))
    expect(isRunning(forging)).toBe(true)
    expect(Option.map(interruptTarget(forging), (t) => t.kind)).toEqual(Option.some("forge"))
    expect(Option.isNone(interruptTarget(idle))).toBe(true)
    // A forge that ended (crash or interrupt) settles with nothing armed.
    const settled = forgeEnded({ followUp: Option.none(), ship: Option.none() })(forging)
    expect(settled._tag).toBe("Forged")
    expect(isRunning(settled)).toBe(false)
    expect(Option.isNone(interruptTarget(settled))).toBe(true)
    await Effect.runPromise(Fiber.interrupt(f))
  })

  test("a replayed run reads like a settled forge, but never displaces a forge in flight", () => {
    const forging = beginForge(doc)(idle)
    expect(replayed({ followUp: Option.some(cid), ship: Option.none() })(forging)).toBe(forging)
    const fromIdle = replayed({ followUp: Option.some(cid), ship: Option.none() })(idle)
    expect(fromIdle._tag).toBe("Forged")
    expect(modeOf(fromIdle)).toBe("forge")
  })
})
