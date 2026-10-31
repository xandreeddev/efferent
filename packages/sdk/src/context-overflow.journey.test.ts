import { expect, test } from "bun:test"
import { join } from "node:path"

// The same real Agent/local Messages protocol runs over packed Node and Bun.
test("context overflow reduces actual requests once while preserving replay, tool admission and billing", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/context-overflow-consumer.fixture.mjs")], {
    stdout: "pipe", stderr: "pipe",
  })
  const watchdog = setTimeout(() => child.kill(), 90_000)
  const [report, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]).finally(() => { clearTimeout(watchdog); child.kill() })
  expect({ code, errors }).toEqual({ code: 0, errors: "" })
  expect(report.match(/"recoveryVerified":true/g)).toHaveLength(9)
  expect(report.match(/"replayVerified":true/g)).toHaveLength(9)
  expect(report.match(/"accountingVerified":true/g)).toHaveLength(9)
  expect(report).toContain('"name":"fallback-actual-smaller-limits"')
  expect(report).toContain('"name":"late-visible-declines","calls":1,"helpers":0')
}, 95_000)
