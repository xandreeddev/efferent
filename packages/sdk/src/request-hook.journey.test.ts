import { expect, test } from "bun:test"
import { join } from "node:path"

test("request hooks survive directory replay and killed prepared-request acknowledgments", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/request-hook-consumer.fixture.mjs")], { stdout: "pipe", stderr: "pipe" })
  const watchdog = setTimeout(() => child.kill(), 70_000)
  const [report, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => { clearTimeout(watchdog); child.kill() })
  expect({ code, errors }).toEqual({ code: 0, errors: "" })
  expect(report).toContain('"checks":7')
  const evidence = ["kitVerified", "actualHookApplied", "oneContext", "placementsVerified", "headerPatchVerified", "materializedV1Verified", "dispatchReplayVerified", "coldReplayHookSkipped", "readOnlyReopenVerified", "patchSnapshotVerified", "durableBeforeAck", "atomicPartsHeaderVerified", "noSendBeforeAck", "heldAckRestartVerified", "takeoverFreshDecisionVerified", "streamFallbackFrozenReuse", "noOpCompatibilityVerified", "originalAckErrorVerified"]
  evidence.map((name) => expect(report).toContain(`"${name}":true`))
}, 75_000)
