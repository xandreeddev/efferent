import { expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"

const required = [
  "peerKitVerified",
  "controlsResponsive", "durableQueueAck", "cancelExactTurn", "lifecycleAckVerified", "protocolOnlyStdout",
  "sigtermStoredShutdown", "restartResumeVerified", "retainedInputOnce", "sigkillWitnessVerified",
  "explicitTakeoverVerified", "noDuplicateHandler", "hardDeadlineStuckSetup", "hardDeadlineStuckFinalizer",
  "secondSignalVerified", "stalledStdoutBounded",
  "nativeExitCodesVerified",
] as const

test("a real parent drives the process protocol, shutdown and restart without losing durable inputs", async () => {
  const child = Bun.spawn([process.execPath, "scripts/process-host-consumer.fixture.mjs"], {
    cwd: new URL("../../../", import.meta.url).pathname,
    stdout: "pipe", stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(code, stderr).toBe(0)
  const line = stdout.split("\n").find((value) => value.startsWith("process-host "))
  expect(line, stderr).toBeDefined()
  const report = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject))(line?.slice("process-host ".length) ?? ""))
  required.map((name) => expect(Option.getOrElse(Option.fromNullishOr(report[name]), () => false), name).toBe(true))
}, 120_000)
