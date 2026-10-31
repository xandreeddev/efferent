import { expect, test } from "bun:test"
import { join } from "node:path"

test("request parts survive files restart, forks and held acknowledgments with exact replay", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/request-parts-consumer.fixture.mjs")], { stdout: "pipe", stderr: "pipe" })
  const watchdog = setTimeout(() => child.kill(), 65_000)
  const [report, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]).finally(() => { clearTimeout(watchdog); child.kill() })
  expect({ code, errors }).toEqual({ code: 0, errors: "" })
  expect(report).toContain('"dedupVerified":true,"replayVerified":true')
  expect(report).toContain('"coldRestartVerified":true')
  expect(report).toContain('"forkCutoffVerified":true')
  expect(report).toContain('"coldForkVerified":true')
  expect(report).toContain('"integrityVerified":true,"prefixVerified":true')
  expect(report.match(/"noDispatchVerified":true/g)).toHaveLength(2)
  expect(report).toContain('"heldAckRestartVerified":true')
  expect(report).toContain('"durableBeforeAck":true,"atomicDependencyBatch":true')
  expect(report).toContain('"noWritesVerified":true')
}, 70_000)
