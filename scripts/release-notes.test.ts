import { expect, test } from "bun:test"
import { releaseNotes } from "./release-notes.js"

test("release notes include the complete selected entry and no adjacent release", () => {
  const text = "# Changelog\n\n## Unreleased\n\nFuture.\n\n## 0.16.0 — 2026-11-03\n\nMemory.\n\n### Fixed\n\nStorage.\n\n## 0.15.1 — 2026-11-02\n\nEarlier.\n"
  expect(releaseNotes(text, "0.16.0")).toBe("Memory.\n\n### Fixed\n\nStorage.\n")
  expect(releaseNotes(text, "0.15.1")).toBe("Earlier.\n")
  expect(releaseNotes(text.replaceAll("\n", "\r\n"), "0.16.0")).toBe("Memory.\n\n### Fixed\n\nStorage.\n")
})

test("release notes reject missing, empty and malformed versions instead of publishing the wrong text", () => {
  expect(() => releaseNotes("## 0.16.0 — 2026-11-03\n", "0.16.0")).toThrow("empty")
  expect(() => releaseNotes("## 0.16.01 — 2026-11-03\nWrong.", "0.16.0")).toThrow("no dated entry")
  expect(() => releaseNotes("## 0.16.0\nUndated.", "0.16.0")).toThrow("no dated entry")
  expect(() => releaseNotes("", "0.16.0\nx=y")).toThrow("stable semantic version")
})
