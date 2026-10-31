import { expect, test } from "bun:test"
import { join } from "node:path"

// The same key-free HTTP faults run over packed packages on Node and Bun.
test("journey: model request policy bounds sends, waits, reads and frozen-step fallback", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/model-retry-consumer.fixture.mjs")], {
    stdout: "pipe", stderr: "pipe",
  })
  const watchdog = setTimeout(() => child.kill(), 60_000)
  const [report, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]).finally(() => {
    clearTimeout(watchdog)
    child.kill()
  })
  expect({ code, errors }).toEqual({ code: 0, errors: "" })
  expect(report.match(/"retryVerified":true/g)).toHaveLength(16)
  expect(report.match(/"accountingVerified":true/g)).toHaveLength(16)
  expect(report).toContain('"name":"mixed-one-counter-and-tool-once","calls":5,"handlers":1,"headers":[2]')
  expect(report).toContain('"name":"stream-fallback-keeps-frozen-step","calls":2,"handlers":0,"headers":[1]')
  expect(report).toContain('"name":"concurrent-reference-overrides","calls":5')
}, 65_000)
