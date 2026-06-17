import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { makeFolderLocks, withFolderLock } from "./folderLock.js"

/**
 * A probe that records whether any two holders of the same lock ever overlap:
 * each holder bumps `active` on entry, asserts it was alone, sleeps, drops it.
 */
const makeProbe = () => {
  let active = 0
  let maxActive = 0
  const enter = (ms: number) =>
    Effect.gen(function* () {
      active++
      maxActive = Math.max(maxActive, active)
      yield* Effect.sleep(`${ms} millis`)
      active--
    })
  return { enter, max: () => maxActive }
}

describe("folderLock", () => {
  test("same-folder effects serialize (never overlap)", async () => {
    const locks = makeFolderLocks()
    const probe = makeProbe()
    await Effect.runPromise(
      Effect.all(
        [
          withFolderLock(locks, "/w/pkg")(probe.enter(20)),
          withFolderLock(locks, "/w/pkg")(probe.enter(20)),
          withFolderLock(locks, "/w/pkg")(probe.enter(20)),
        ],
        { concurrency: "unbounded" },
      ),
    )
    expect(probe.max()).toBe(1)
  })

  test("different folders fan out in parallel", async () => {
    const locks = makeFolderLocks()
    const probe = makeProbe()
    await Effect.runPromise(
      Effect.all(
        [
          withFolderLock(locks, "/w/a")(probe.enter(30)),
          withFolderLock(locks, "/w/b")(probe.enter(30)),
          withFolderLock(locks, "/w/c")(probe.enter(30)),
        ],
        { concurrency: "unbounded" },
      ),
    )
    expect(probe.max()).toBeGreaterThan(1)
  })

  test("the lock releases on failure — the next holder still runs", async () => {
    const locks = makeFolderLocks()
    const order: string[] = []
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* withFolderLock(locks, "/w/p")(Effect.fail("boom")).pipe(
          Effect.catchAll(() => Effect.sync(() => order.push("failed"))),
        )
        yield* withFolderLock(locks, "/w/p")(Effect.sync(() => order.push("ran")))
        return order
      }),
    )
    expect(result).toEqual(["failed", "ran"])
  })
})
