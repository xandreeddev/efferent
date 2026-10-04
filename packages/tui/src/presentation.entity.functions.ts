import type { TranscriptBlock } from "./presentation.entity.js"
import { Chunk, Option, Schema } from "effect"
import { Failure, ShellResult } from "@xandreed/core"

const conciseFailure = (message: string): string => message.split("\n")[0]!
  .replace(/^(?:(?:SmithToolFailure|HarnessError|UnknownError|Error|effect\/ai\/AiError\/[A-Za-z]+):\s*)+/, "")
  .split(/\s*\{/)[0]!
  .replace(/^[A-Za-z][A-Za-z0-9_]*\.(?:generateText|streamText|generateObject):\s*/, "")
  .replace(/^Invalid request\.\s+(?=\S)/, "")
  .trim().slice(0, 180)

/** Keep the useful error in the conversation; complete evidence stays in the inspector. */
export const failureMessageSummary = (message: string): string => /ENOENT|no such file or directory/i.test(message) ? "File not found"
  : /EACCES|EPERM|permission denied/i.test(message) ? "Permission denied"
  : /EISDIR|is a directory/i.test(message) ? "Expected a file, found a directory"
  : /ENOTDIR|not a directory/i.test(message) ? "Expected a directory"
  : conciseFailure(message) || "The operation failed. Ctrl+O for details."

export const toolFailureSummary = (value: unknown, knownFailure = false): Option.Option<string> => Option.orElse(Option.orElse(
  Option.map(Schema.decodeUnknownOption(Failure)(value), (failure) => failureMessageSummary(failure.message)),
  () => Option.flatMap(Schema.decodeUnknownOption(ShellResult)(value), (result) => result.exitCode === 0 ? Option.none()
    : Option.some(`Exit ${result.exitCode}${result.stderr.trim() ? ` · ${result.stderr.trim().split("\n")[0]}` : ""}`.slice(0, 500))),
), () => knownFailure && typeof value === "string" ? Option.some(failureMessageSummary(value)) : Option.none())

/** Keep failures and active work visible; only completed exploration folds. */
export const groupActivities = (blocks: ReadonlyArray<TranscriptBlock>): ReadonlyArray<TranscriptBlock> =>
  Chunk.toReadonlyArray(blocks.reduce((grouped, block) => Option.match(Chunk.last(grouped), {
    onNone: () => Chunk.append(grouped, block),
    onSome: (previous) => {
    if (block.kind !== "tool" || block.category !== "read" || block.status !== "complete" ||
      previous.kind !== "tool" || previous.category !== "read" || previous.status !== "complete" || previous.runId !== block.runId || previous.sourceSession !== block.sourceSession) return Chunk.append(grouped, block)
    const members = [...(previous.members ?? [previous.id]), block.id]
    return Chunk.append(Chunk.dropRight(grouped, 1), { ...previous, members,
      text: `${members.length} read/search calls`, detail: `${previous.detail || previous.text}\n\n${block.text}\n${block.detail}` })
    },
  }), Chunk.empty<TranscriptBlock>()))

export const formatTokens = (value: number): string => value >= 1_000 ? `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k` : String(value)

export const detailPreview = (text: string): string => text.length <= 64_000 ? text : `${text.slice(0, 64_000)}\n\n… preview clipped`

export const filterRows = <A extends { readonly label: string; readonly detail: string }>(rows: ReadonlyArray<A>, query: string): ReadonlyArray<A> =>
  query.trim().length === 0 ? rows : rows.filter((row) => `${row.label} ${row.detail}`.toLowerCase().includes(query.toLowerCase()))
