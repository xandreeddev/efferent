import { expect, test } from "bun:test"
import { join } from "node:path"

test("intercepted tool results survive held presentation, cancellation and process death", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/tool-interceptor-consumer.fixture.mjs")], { stdout: "pipe", stderr: "pipe" })
  const watchdog = setTimeout(() => child.kill(), 70_000)
  const [report, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => { clearTimeout(watchdog); child.kill() })
  expect({ code, errors }).toEqual({ code: 0, errors: "" })
  const evidence = ["oneEffectiveAck", "actualOnToolPreserved", "rewriteRecorded", "encodedEvidenceVerified", "rawBeforeView", "incrementalSiblingAck", "returnedBeforeCancel", "cancelledAfterInterruptible", "noHeldRawResult", "coldReplayVerified", "readOnlyReopenVerified", "interruptedRepairVerified", "noAutomaticReplay", "coldViewsVerified", "sigkillRecoveryVerified", "journalCodecVerified", "presentationNoDuplicate"]
  evidence.map((name) => expect(report).toContain(`"${name}":true`))
}, 75_000)
