import { expect, test } from "bun:test"
import { claimRecovery, initialAttempt, settledAttempt, visibleAttempt } from "./request-attempt.entity.functions.js"

test("each recovery is claimed once and settled fallback never rearms either allowance", () => {
  const initial = initialAttempt(true)
  const [yes, overflow] = claimRecovery(initial, "overflow")
  expect(yes).toBe(true)
  expect(claimRecovery(overflow, "overflow")).toEqual([false, overflow])
  const [media, both] = claimRecovery(settledAttempt(overflow), "media")
  expect(media).toBe(true)
  expect(both).toEqual({ _tag: "SettledOnly", visibility: "Silent", media: "Used", overflow: "Used" })
  expect(claimRecovery(both, "overflow")).toEqual([false, both])
  expect(claimRecovery(both, "media")).toEqual([false, both])
  const visible = visibleAttempt(initial)
  expect(claimRecovery(visible, "overflow")).toEqual([false, visible])
  expect(initialAttempt(false)._tag).toBe("SettledOnly")
})
