import { describe, expect, test } from "bun:test"
import { isTestCode, verifyRefusals } from "./build-check.js"
import type { VerifyState } from "./build-check.js"

const commit = "9b898c1bb0740d8ba71cd8429cc5b408c46755cb"
const state = (overrides: Partial<VerifyState> = {}): VerifyState => ({
  stamp: { commit, dirty: false, version: "0.14.0", packages: [{ dir: "core", name: "@xandreed/core", version: "0.14.0" }] },
  head: { success: true, stdout: commit, stderr: "" },
  testCode: [],
  allowDirty: false,
  ...overrides,
})

describe("the package build", () => {
  test("leaves out tests, testing modules, test-only ports, testing folders and their declarations", () => {
    const left = [
      "src/agent.test.ts", "src/agent.golden.test.ts", "src/stats.bench.ts", "dist/agent.golden.test.d.ts",
      "src/turn/testing.ts", "dist/turn/testing.d.ts", "dist/turn/testing.js", "src/cli-fixture.testing.ts",
      "src/testing.port.ts", "dist/testing.port.d.ts", "src/testing/version.port.ts", "dist/testing/fixture.testing.d.ts", "testing",
    ]
    const kept = ["src/index.ts", "dist/index.d.ts", "src/workspace/bash.conformance.ts", "src/turn/turn.port.ts", "src/attesting.ts", "src/testing-tools.ts", "skills/test/SKILL.md"]
    expect(left.filter((file) => !isTestCode(file))).toEqual([])
    expect(kept.filter(isTestCode)).toEqual([])
  })
})

describe("verify:packages", () => {
  test("checks a clean build of HEAD", () => {
    expect(verifyRefusals(state())).toEqual([])
  })

  test("refuses a build of another commit, even with --allow-dirty: its artifacts are stale", () => {
    const head = { success: true, stdout: "15d6dc518d5a8d0d6f1f2bba3a6e46d3c6fb1a22", stderr: "" }
    expect(verifyRefusals(state({ head }))).toEqual(["the build is from 9b898c1bb07, but HEAD is 15d6dc518d5; rebuild"])
    expect(verifyRefusals(state({ head, allowDirty: true }))).toEqual(["the build is from 9b898c1bb07, but HEAD is 15d6dc518d5; rebuild"])
    expect(verifyRefusals(state({ stamp: { ...state().stamp, commit: null } }))).toEqual(["the build was not made in a git checkout; rebuild"])
  })

  test("refuses a build of a tree with changes unless --allow-dirty", () => {
    const dirty = state({ stamp: { ...state().stamp, dirty: true } })
    expect(verifyRefusals(dirty)).toEqual([
      "the build was made from a working tree with changes (or ignored files in a package's published folders); rebuild from a clean checkout, or pass --allow-dirty to check a build of uncommitted changes",
    ])
    expect(verifyRefusals({ ...dirty, allowDirty: true })).toEqual([])
  })

  test("refuses built packages that hold test code", () => {
    expect(verifyRefusals(state({ testCode: ["sdk/dist/testing.port.js", "sdk/dist/agent.golden.test.d.ts"] })))
      .toEqual(["the built packages hold test code: sdk/dist/testing.port.js, sdk/dist/agent.golden.test.d.ts; rebuild"])
  })
})
