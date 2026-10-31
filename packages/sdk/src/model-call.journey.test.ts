import { expect, test } from "bun:test"
import { join } from "node:path"

test("actual loop and helper calls are billed through late finalizers without changing selected turn usage", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/model-call-consumer.fixture.mjs")], {
    stdout: "pipe", stderr: "pipe",
  })
  const watchdog = setTimeout(() => child.kill(), 25_000)
  const [report, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]).finally(() => { clearTimeout(watchdog); child.kill() })
  expect({ code, errors }).toEqual({ code: 0, errors: "" })
  expect(report).toContain('"calls":3,"selected":38,"billed":114,"accountingVerified":true')
}, 30_000)
