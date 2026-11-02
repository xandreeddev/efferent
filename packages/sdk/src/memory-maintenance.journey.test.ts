import { expect, test } from "bun:test"
import { join } from "node:path"

test("summaries run after sealed replies, on reported input, for agents and manual compositions", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/memory-maintenance-consumer.fixture.mjs")], {
    stdout: "pipe", stderr: "pipe",
  })
  const watchdog = setTimeout(() => child.kill(), 25_000)
  const [report, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]).finally(() => { clearTimeout(watchdog); child.kill() })
  expect({ code, errors }).toEqual({ code: 0, errors: "" })
  expect(report).toContain('"summaries":1,"manualAfterReply":1,"maintenanceVerified":true')
}, 30_000)
