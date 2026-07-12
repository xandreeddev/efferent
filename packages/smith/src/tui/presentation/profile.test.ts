import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { initialProfile, reduceProfile } from "./profile.js"

describe("profile presentation state", () => {
  test("draft details remain visible after the exact draft is locked", () => {
    const drafted = reduceProfile(initialProfile, {
      type: "profile_draft",
      draftDir: ".efferent/profile-draft",
      rules: [{ rule: "effect/no-let", findings: 0 }],
      boundaryViolations: 0,
      checks: [{ name: "tests", status: "green" }],
    })
    const locked = reduceProfile(drafted, {
      type: "profile_locked",
      configPath: "foundry.config.ts",
      rules: 1,
      grandfathered: 0,
      checks: 1,
    })
    expect(locked.locked).toBe(true)
    expect(locked.rules).toEqual([{ rule: "effect/no-let", findings: 0 }])
    expect(Option.getOrThrow(locked.configPath)).toBe("foundry.config.ts")
  })
})
