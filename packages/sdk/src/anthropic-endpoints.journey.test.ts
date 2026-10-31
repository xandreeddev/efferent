import { expect, test } from "bun:test"
import { join } from "node:path"

// The shared real-Agent HTTP fixture also runs on packed Node and Bun in
// verify:packages. Its signatures are fake opaque bytes, with no provider key.
test("journey: configured Messages endpoints preserve signed thinking through a durable tool turn", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/anthropic-messages-consumer.fixture.mjs")], {
    stdout: "pipe", stderr: "pipe",
  })
  const reading = new Response(child.stdout).text()
  const errors = await new Response(child.stderr).text()
  const output = await reading
  expect({ code: await child.exited, errors, report: output.includes('"signedRoundTrip":true') }).toEqual({ code: 0, errors: "", report: true })
}, 50_000)
