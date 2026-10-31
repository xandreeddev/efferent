import { expect, test } from "bun:test"
import { join } from "node:path"

const run = async (mode: string) => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../scripts/langsmith-telemetry-consumer.fixture.mjs"), mode], { stdout: "pipe", stderr: "pipe" })
  const deadline = setTimeout(() => child.kill(), 85_000)
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]).finally(() => { clearTimeout(deadline); child.kill() })
  expect({ code, errors }).toEqual({ code: 0, errors: "" })
  return output
}

test("LangSmith's local OTLP collector receives native inference once, honest unknown usage and gated content", async () => {
  const output = await run("collector")
  const evidence = ["localCollectorVerified", "nativeTextObjectStreamOnce", "opaqueUsageUnknown", "explicitBoundaryOnce", "contentConsentVerified", "plannedToolNotInference", "streamFallbackNoDoubleUsage", "routedHelperNoDoubleUsage", "routedCompatReportedUsage", "omittedProviderUsageUnknown"]
  evidence.map((name) => expect(output).toContain(`"${name}":true`))
  expect(output).toContain('"liveLangSmithIngestionVerified":false')
}, 90_000)

test("fresh OS task recovery preserves stored sampled ancestry for real initial and queued child turns", async () => {
  const output = await run("ancestry")
  const evidence = ["freshProcessTaskAncestry", "sampledTrueAndFalsePreserved", "firstCommittedParentWins", "actualChildAgentAncestry", "initialAndFollowupOnce", "bookkeepingNoExecutionSpan"]
  evidence.map((name) => expect(output).toContain(`"${name}":true`))
}, 90_000)
