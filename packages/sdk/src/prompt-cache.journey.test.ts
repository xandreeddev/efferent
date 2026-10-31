import { expect, test } from "bun:test"
import { join } from "node:path"

// The same real Agent/cache fixture is run from packed packages on Node and
// Bun. Local responses prove request planning and replay, not cache hits.
test("journey: cache policies preserve the stable prefix, volatile boundary and signed tool history", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/anthropic-messages-consumer.fixture.mjs"), "--prompt-cache"], {
    stdout: "pipe", stderr: "pipe",
  })
  const output = new Response(child.stdout).text()
  const errors = await new Response(child.stderr).text()
  const report = await output
  expect({ code: await child.exited, errors }).toEqual({ code: 0, errors: "" })
  expect(report.match(/"cacheVerified":true/g)).toHaveLength(7)
  expect(report.match(/"volatileBoundary":true/g)).toHaveLength(7)
  expect(report).toContain('"cachePolicy":"TopLevel","cacheControl":false')
  expect(report).toContain('"cachePolicy":"Off","cacheControl":true')
}, 50_000)
