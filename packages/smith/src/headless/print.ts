import { Effect, Fiber, Match, Option, Queue } from "effect"
import { renderFindingLine, renderReportSummary } from "@xandreed/foundry"
import type { FileSystem } from "@xandreed/sdk-core"
import type { SmithEvent } from "../domain/SmithEvent.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"
import type { ImplementorServices } from "../implementor/efferentImplementor.js"
import { runForgeSession } from "../forge/session.js"

const MAX_FINDING_LINES = 8

const clip = (text: string, max: number): string => {
  const oneLine = text.split("\n")[0] ?? ""
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

/** One stdout line (or block) per smith event; `None` = silent event. */
export const renderEventLines = (event: SmithEvent): Option.Option<string> =>
  Match.value(event).pipe(
    Match.when({ type: "forge_start" }, (e) =>
      Option.some(
        `─ forge: ${clip(e.spec.goal, 100)}\n  gates: ${e.gateNames.join(" → ")} · attempts ≤ ${e.spec.limits.maxAttempts}`,
      ),
    ),
    Match.when({ type: "attempt_start" }, (e) =>
      Option.some(`\n── attempt ${e.attempt} ──`),
    ),
    Match.when({ type: "implement_end" }, (e) =>
      Option.some(
        `  implemented: ${e.filesTouched.length} file(s) touched${Option.match(e.ref, {
          onNone: () => "",
          onSome: (ref) => ` · ${ref}`,
        })}`,
      ),
    ),
    Match.when({ type: "gate_start" }, (e) => Option.some(`  gate: ${e.gate}…`)),
    Match.when({ type: "gate_report" }, (e) => {
      const findings = e.report.failures
        .flatMap((failure) => failure.findings)
        .slice(0, MAX_FINDING_LINES)
        .map((finding) => `      ${renderFindingLine(finding)}`)
      return Option.some(
        [`  ${renderReportSummary(e.report)}`, ...findings].join("\n"),
      )
    }),
    Match.when({ type: "forge_end" }, (e) =>
      Option.some(
        `\n${e.run.outcome._tag === "accepted" ? "✓ ACCEPTED" : `✗ REJECTED (${e.run.outcome.reason})`} after ${e.run.attempts.length} attempt(s)\n  artifact: ${e.artifact}`,
      ),
    ),
    Match.when({ type: "forge_error" }, (e) => Option.some(`✗ forge failed: ${e.message}`)),
    Match.when({ type: "agent" }, (e) =>
      Match.value(e.event).pipe(
        Match.when({ type: "tool_call_start" }, (t) =>
          Option.some(`    ⚙ ${t.toolName}${describeArgs(t.args)}`),
        ),
        Match.when({ type: "assistant_message" }, (m) =>
          m.text.trim().length > 0 ? Option.some(`    ✦ ${clip(m.text.trim(), 140)}`) : Option.none(),
        ),
        Match.when({ type: "subagent_start" }, (s) =>
          Option.some(`    ◆ spawned ${s.name}${s.role !== undefined ? ` (${s.role})` : ""}`),
        ),
        Match.when({ type: "subagent_end" }, (s) =>
          Option.some(`    ◆ ${s.name} ${s.ok ? "done" : "failed"}: ${clip(s.summary, 100)}`),
        ),
        Match.when({ type: "llm_retry" }, (r) =>
          Option.some(`    ⟳ llm retry ${r.attempt}/${r.maxAttempts}: ${clip(r.reason, 80)}`),
        ),
        Match.orElse(() => Option.none<string>()),
      ),
    ),
    Match.exhaustive,
  )

const describeArgs = (args: unknown): string => {
  if (typeof args !== "object" || args === null) return ""
  const primary = ["path", "command", "pattern", "name", "query"]
    .map((key) => (args as Record<string, unknown>)[key])
    .find((value) => typeof value === "string")
  return typeof primary === "string" ? `(${clip(primary, 60)})` : ""
}

/**
 * `-p` mode: run the forge session with every event rendered live as stdout
 * lines. Exit code: 0 accepted · 1 rejected · 2 infrastructure error.
 */
export const runHeadless = (
  run: SmithRunConfig,
): Effect.Effect<number, never, ImplementorServices | FileSystem> =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Option.Option<SmithEvent>>()
    const publish = (event: SmithEvent) =>
      Queue.offer(queue, Option.some(event)).pipe(Effect.asVoid)

    const printer = yield* Effect.fork(
      Effect.gen(function* () {
        const next = yield* Queue.take(queue)
        return Option.match(next, {
          onNone: () => false,
          onSome: (event) => {
            Option.match(renderEventLines(event), {
              onNone: () => undefined,
              onSome: (lines) => console.log(lines),
            })
            return true
          },
        })
      }).pipe(Effect.repeat({ while: (more) => more }), Effect.asVoid),
    )

    const outcome = yield* runForgeSession(run, publish).pipe(
      Effect.map((result) => (result.run.outcome._tag === "accepted" ? 0 : 1)),
      Effect.catchAll(() => Effect.succeed(2)),
    )
    // Flush: the None sentinel ends the printer after every queued event printed.
    yield* Queue.offer(queue, Option.none())
    yield* Fiber.join(printer)
    return outcome
  })
