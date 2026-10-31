import { expect, test } from "bun:test"
import { join } from "node:path"

test("summary snapshots keep full archive semantics and survive cold forks and combined-pointer ACK loss", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/memory-snapshot-consumer.fixture.mjs")], { stdout: "pipe", stderr: "pipe" })
  const watchdog = setTimeout(() => child.kill(), 75_000)
  const [report, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]).finally(() => { clearTimeout(watchdog); child.kill() })
  expect({ code, errors }).toEqual({ code: 0, errors: "" })
  const evidence = ["kitVerified", "snapshotPublishedVerified", "pointerAtomicVerified", "mediaSnapshotVerified", "coldProjectionVerified", "readOnlyReopenVerified", "archiveRecallVerified", "lateOverlayFallbackVerified", "oldAnchorFuturePublicationVerified", "forkCutoffVerified", "missingFutureMediaIgnored", "durablePointerBeforeAckVerified", "heldAckRecoveryVerified"]
  evidence.map((name) => expect(report).toContain(`"${name}":true`))
  expect(report.match(/"projectionReuseVerified":true/g)).toHaveLength(2)
  expect(report.match(/"projectedBuildReads":0/g)).toHaveLength(2)
  expect(report.match(/"replayVerified":true/g)).toHaveLength(4)
}, 80_000)
