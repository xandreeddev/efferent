import { expect, test } from "bun:test"
import { join } from "node:path"

test("media references survive files restart, fork cutoffs and publication/ACK process loss", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/media-store-consumer.fixture.mjs")], { stdout: "pipe", stderr: "pipe" })
  const watchdog = setTimeout(() => child.kill(), 75_000)
  const [report, errors, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]).finally(() => { clearTimeout(watchdog); child.kill() })
  expect({ code, errors }).toEqual({ code: 0, errors: "" })
  const evidence = ["kitsVerified", "dedupVerified", "coverageVerified", "logicalHashReplayVerified", "legacyInlineVerified", "literalExtrasVerified", "coldRestartVerified", "noRewriteVerified", "forkCutoffBeforeHydrationVerified", "missingFutureIgnored", "sharedBlobRetentionVerified", "missingNoDispatchVerified", "corruptNoDispatchVerified", "durableBeforeAckVerified", "heldAckRestartVerified"]
  evidence.map((name) => expect(report).toContain(`"${name}":true`))
  expect(report.match(/"publicationVerified":true/g)).toHaveLength(2)
  expect(report.match(/"recoveredVerified":true/g)).toHaveLength(3)
  expect(report).toContain('"durableBlob":false,"noDanglingReference":true')
  expect(report).toContain('"durableBlob":true,"noDanglingReference":true')
}, 80_000)
