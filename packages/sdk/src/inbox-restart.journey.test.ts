import { expect, test } from "bun:test"
import { join } from "node:path"

// The same controller and real child agents run against the packed packages
// on Node and Bun in verify:packages. Every holder is killed and awaited by
// the controller; a disconnected holder exits when its stdin closes.
test("journey: durable steering and queued input survive a killed tool and a second kill after take", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/inbox-restart-consumer.fixture.mjs")], {
    stdout: "pipe", stderr: "pipe",
  })
  const reading = new Response(child.stdout).text()
  const errors = await new Response(child.stderr).text()
  const output = await reading
  expect({ code: await child.exited, errors, completed: output.includes('"checkpoint":"taken"') }).toEqual({ code: 0, errors: "", completed: true })
}, 60_000)
