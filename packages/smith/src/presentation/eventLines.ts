import { Match, Option } from "effect"
import { renderFindingLine, renderReportSummary } from "@xandreed/foundry"
import type { SmithEvent } from "../domain/SmithEvent.js"

const MAX_FINDING_LINES = 8

export const clip = (text: string, max: number): string => {
  const oneLine = text.split("\n")[0] ?? ""
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

const describeArgs = (args: unknown): string => {
  if (typeof args !== "object" || args === null) return ""
  const primary = ["path", "command", "pattern", "name", "query"]
    .map((key) => (args as Record<string, unknown>)[key])
    .find((value) => typeof value === "string")
  return typeof primary === "string" ? `(${clip(primary, 60)})` : ""
}

/** One label per AGENT event (the engine's `LoopEvent`) for a live feed;
 *  `None` = silent event. */
export const agentEventLabel = (event: SmithEvent & { type: "agent" }): Option.Option<string> =>
  Match.value(event.event).pipe(
    Match.when({ type: "tool_start" }, (t) =>
      Option.some(`⚙ ${t.toolName}${describeArgs(t.args)}`),
    ),
    Match.when({ type: "tool_end" }, (t) =>
      t.ok ? Option.none<string>() : Option.some(`⚠ ${t.toolName} failed`),
    ),
    Match.when({ type: "assistant_message" }, (m) =>
      m.text.trim().length > 0 ? Option.some(`✦ ${clip(m.text.trim(), 140)}`) : Option.none(),
    ),
    Match.when({ type: "error" }, (e) => Option.some(`✗ ${clip(e.message, 120)}`)),
    Match.orElse(() => Option.none<string>()),
  )

/** One stdout line (or block) per smith event for the headless printer; `None` = silent. */
export const renderEventLines = (event: SmithEvent): Option.Option<string> =>
  Match.value(event).pipe(
    Match.when({ type: "refine_start" }, (e) =>
      Option.some(
        `─ refine: ${Option.match(e.idea, { onNone: () => "(interactive)", onSome: (idea) => clip(idea, 100) })}`,
      ),
    ),
    Match.when({ type: "spec_draft" }, (e) =>
      Option.some(`── spec draft (${e.doc.slug}) → ${e.path} ──`),
    ),
    Match.when({ type: "spec_locked" }, (e) =>
      Option.some(`✓ spec LOCKED: ${e.doc.slug} → ${e.path}`),
    ),
    Match.when({ type: "refine_error" }, (e) =>
      Option.some(`✗ refine failed: ${e.message}`),
    ),
    Match.when({ type: "forge_start" }, (e) =>
      Option.some(
        `─ forge: ${clip(e.spec.goal, 100)}${Option.match(e.doc, {
          onNone: () => "",
          onSome: (doc) => ` (spec: ${doc.slug})`,
        })}\n  gates: ${e.gateNames.join(" → ")} · attempts ≤ ${e.spec.limits.maxAttempts}`,
      ),
    ),
    Match.when({ type: "vacuous_checks" }, (e) =>
      Option.some(
        `⚠ red-first: ${e.names.join(", ")} already pass on the UNTOUCHED workspace — they cannot measure this spec's work`,
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
      return Option.some([`  ${renderReportSummary(e.report)}`, ...findings].join("\n"))
    }),
    Match.when({ type: "forge_end" }, (e) =>
      Option.some(
        `\n${
          e.run.outcome._tag === "accepted"
            ? "✓ ACCEPTED"
            : e.run.outcome._tag === "rejected"
              ? `✗ REJECTED (${e.run.outcome.reason})`
              : "◌ IN FLIGHT"
        } after ${e.run.attempts.length} attempt(s)\n  artifact: ${e.artifact}`,
      ),
    ),
    Match.when({ type: "forge_error" }, (e) => Option.some(`✗ forge failed: ${e.message}`)),
    Match.when({ type: "agent" }, (e) =>
      Option.map(agentEventLabel(e), (label) => `    ${label}`),
    ),
    Match.exhaustive,
  )
