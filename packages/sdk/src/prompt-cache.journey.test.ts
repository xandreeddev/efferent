import { expect, test } from "bun:test"
import { join } from "node:path"

// The same real Agent/cache fixture is run from packed packages on Node and
// Bun. Local responses prove request planning and replay, not cache hits.
test("journey: cache policies preserve the stable prefix, volatile boundary and signed tool history", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/anthropic-messages-consumer.fixture.mjs"), "--prompt-cache"], {
    stdout: "pipe", stderr: "pipe", timeout: 40_000,
  })
  const [report, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]).finally(() => child.kill())
  expect({ code, errors }).toEqual({ code: 0, errors: "" })
  expect(report.match(/"cacheVerified":true/g)).toHaveLength(7)
  expect(report.match(/"volatileBoundary":true/g)).toHaveLength(7)
  expect(report).toContain('"cachePolicy":"TopLevel","cacheControl":false')
  expect(report).toContain('"cachePolicy":"Off","cacheControl":true')
}, 50_000)
