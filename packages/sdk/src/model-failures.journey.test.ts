import { expect, test } from "bun:test"
import { join } from "node:path"

// The same local HTTP failures run over packed packages on Node and Bun.
// Fixed responses establish classification/control flow, not live behavior.
test("journey: permanent model failures retain their meaning and never dispatch tools or fallback", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/model-failures-consumer.fixture.mjs")], {
    stdout: "pipe", stderr: "pipe", timeout: 80_000,
  })
  const [report, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]).finally(() => child.kill())
  expect({ code, errors }).toEqual({ code: 0, errors: "" })
  expect(report.match(/"failureVerified":true/g)).toHaveLength(13)
  expect(report).toContain('"name":"http-size-413-is-not-context","code":"model.invalid-request"')
  expect(report).toContain('"name":"ordinary-output-limit-remains-bounded","code":"loop.truncated","calls":3')
}, 90_000)
