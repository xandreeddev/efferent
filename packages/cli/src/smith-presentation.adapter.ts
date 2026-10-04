import { Option, Schema } from "effect"
import type { SessionLogEvent } from "@xandreed/core"
import { EditProposal, EditReceipt, VerificationCheck } from "@xandreed/smith"
import type { InspectorRow, JournalRenderers, TranscriptBlock } from "@xandreed/tui"

const detail = (event: SessionLogEvent) => JSON.stringify(event.data, null, 2)
const block = (event: SessionLogEvent, text: string, extra: Partial<TranscriptBlock> = {}): TranscriptBlock => ({
  id: `${event.session}:${event.seq}`, kind: "notice", text, detail: detail(event), status: "complete",
  sourceSession: event.session, ...extra,
})

/** Smith supplies product labels; the reusable terminal only understands presentation values. */
export const smithJournalRenderers: JournalRenderers = {
  // The routing decision is available in /context; it needs no transcript row.
  "smith.planning": () => [],
  "smith.models": () => [],
  "smith.editor": (event, turn) => [block(event, event.data.status === "started" ? "Editor preparing changes" : event.data.status === "completed" ? "Editor proposal ready" : "Editor needs another attempt", {
    id: `${event.session}:editor:${String(event.data.workOrderId)}:${String(event.data.attempt)}`,
    category: "handoff", role: String(event.data.role || "editor"), ...(typeof event.data.model === "string" ? { model: event.data.model } : {}),
    ...(event.data.status === "failed" ? { detail: String(event.data.failure || "The editor did not submit a complete proposal") } : {}),
    status: event.data.status === "started" ? "running" : event.data.status === "completed" ? "complete" : "failed",
    ...Option.match(turn, { onNone: () => ({}), onSome: (value) => ({ runId: value.runId }) }),
  })],
  "smith.proposal": (event) => [block(event, String(event.data.summary || "Changes ready for controller review"), { category: "edit" })],
}

const rowOf = (event: SessionLogEvent): InspectorRow => {
  const base = { id: `${event.session}:${event.seq}`, label: event.kind.replaceAll("smith.", "").replaceAll("memory.", ""),
    detail: `turn ${Option.getOrElse(event.turn, () => 0)} · ${new Date(event.at).toLocaleTimeString()}`, text: detail(event) }
  if (event.kind === "smith.check") return Option.match(Schema.decodeUnknownOption(VerificationCheck)(event.data), {
    onNone: () => base,
    onSome: (check) => ({ ...base, label: check.command, detail: `Exit ${check.exitCode} · ${check.exitCode === 0 ? "passed" : "failed"}`,
      status: check.exitCode === 0 ? "complete" : "failed", text: `${check.command}\nExit ${check.exitCode}\n\n${check.stdout}${check.stderr ? `\n${check.stderr}` : ""}` }),
  })
  if (event.kind === "smith.proposal") return Option.match(Schema.decodeUnknownOption(EditProposal)(event.data), {
    onNone: () => base,
    onSome: (proposal) => ({ ...base, label: proposal.summary || "Staged changes", detail: `${proposal.changes.length} files · awaiting review`,
      text: `${proposal.summary}\n\n${proposal.changes.map((change) => `${change.path}\n${Option.getOrElse(change.content, () => "(deleted)")}`).join("\n\n")}` }),
  })
  if (event.kind === "smith.receipt") return Option.match(Schema.decodeUnknownOption(EditReceipt)(event.data), {
    onNone: () => base,
    onSome: (receipt) => ({ ...base, label: `Applied ${receipt.paths.length} files`, detail: receipt.status, status: "complete", text: receipt.paths.join("\n") || "No file changes" }),
  })
  if (event.kind === "smith.editor") return { ...base, id: `${event.session}:editor:${String(event.data.workOrderId)}:${String(event.data.attempt)}`,
    label: `${event.data.role === "controller" ? "Controller retry" : "Editor"} · attempt ${String(event.data.attempt)}`,
    detail: `${String(event.data.status)} · ${String(event.data.model || "")}`, text: typeof event.data.failure === "string" ? event.data.failure : `Model: ${String(event.data.model)}\nStatus: ${String(event.data.status)}`,
    status: event.data.status === "started" ? "running" : event.data.status === "completed" ? "complete" : "failed" }
  if (event.kind === "smith.planning") return { ...base, label: event.data.mode === "plan" ? "Internal planning" : "Direct work", detail: String(event.data.outcome), text: String(event.data.reason) }
  if (event.kind === "smith.models") return { ...base, label: "Model roles", text: `Controller: ${String(event.data.driver)}\nEditor: ${String(event.data.editor)}` }
  return base
}

/** On-demand inspection folds operation updates while retaining complete journal evidence. */
export const journalRows = (events: ReadonlyArray<SessionLogEvent>, kinds: ReadonlyArray<string>): ReadonlyArray<InspectorRow> =>
  events.filter((event) => kinds.some((kind) => event.kind.startsWith(kind))).slice(-60).map(rowOf).reduce((rows: ReadonlyArray<InspectorRow>, row) =>
    rows.some((previous) => previous.id === row.id) ? rows.map((previous) => previous.id === row.id ? row : previous) : [...rows, row], []).slice(-30)
