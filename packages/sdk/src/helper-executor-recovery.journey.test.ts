import { expect, test } from "bun:test"
import { join } from "node:path"

test("helper questions and exact answer outboxes survive witnessed SIGKILL and lost end acknowledgement", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/helper-executor-consumer.fixture.mjs")], { stdout: "pipe", stderr: "pipe" })
  const watchdog = setTimeout(() => child.kill(), 95_000)
  const [report, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => { clearTimeout(watchdog); child.kill() })
  expect({ code, errors }).toEqual({ code: 0, errors: "" })
  const evidence = ["durableWitness", "liveHolderPreserved", "bookkeepingWithoutExecutor", "repeatedKillRepair", "uniqueRecoveryKeys", "abandonedTurnKeysVerified", "exactOutboxRepaired", "answerOnce", "borrowedTaskRoute", "lostEndAckRecovered", "terminalResultOnce", "sigkillRecoveryVerified"]
  evidence.map((name) => expect(report).toContain(`"${name}":true`))
}, 100_000)
