import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mediaFromBase64, mediaLabel, mediaSlotsOf, UNAVAILABLE_MEDIA_DATA } from "../domain/media.entity.functions.js"
import { ToolCallId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import type { RenderOptions } from "./memory-log.entity.functions.js"
import { buildContext, entriesSendingMedia, entryId } from "./memory-log.entity.functions.js"
import type { LogEntry } from "./memory-log.entity.js"

// An image whose stored bytes a media store lost keeps its metadata and `UNAVAILABLE_MEDIA_DATA`
// (what `withMediaStore` restores it as): every render shows its label line and never sends it.
const pixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const sent = Effect.runSync(mediaFromBase64(pixelPng, { name: "kept.png" }))
const lost = { ...Effect.runSync(mediaFromBase64(pixelPng, { name: "lost.png", alt: "a chart" })), data: UNAVAILABLE_MEDIA_DATA }
const run = RunId.make("run-1")
const entries: ReadonlyArray<LogEntry> = [
  { id: entryId(run, 0), runId: run, turn: 1, step: 0, at: 0, body: { _tag: "TurnStarted", userMessage: new UserMessage({ text: "look", attachments: [sent, lost] }) } },
  { id: entryId(run, 1), runId: run, turn: 1, step: 0, at: 0, body: { _tag: "Message", run: RunOrdinal.make(0), message: { role: "assistant", content: [{ type: "tool-call", toolCallId: ToolCallId.make("shot"), toolName: "shot", input: {}, providerExecuted: false }] } } },
  { id: entryId(run, 2), runId: run, turn: 1, step: 0, at: 0, body: { _tag: "ToolResult", run: RunOrdinal.make(0), toolCallId: ToolCallId.make("shot"), toolName: "shot", isError: false,
    encoded: { image: lost }, view: "a screenshot", viewVersion: "1", subjects: [], artifacts: [], pinned: false, media: mediaSlotsOf({ image: lost }) } },
]
const options: RenderOptions = {
  strategy: "test", currentTurn: 1, currentRun: run, run: RunOrdinal.make(0), turnContext: "current", replies: false, stepContext: "tail", digests: false,
  media: { mode: "inline", maxImages: 8, maxChars: 20_000_000 },
}

test("an attachment whose bytes are unavailable renders as its label beside the images still sent", () => {
  const user = buildContext(entries, options).messages[0]!
  expect(user).toEqual({ role: "user", content: [sent, { type: "text", text: `look\n${mediaLabel(lost)}` }] })
})

test("a tool result image whose bytes are unavailable renders as its label and sends no media", () => {
  const tool = buildContext(entries, options).messages.find((message) => message.role === "tool")!
  expect(tool.content).toEqual([{ type: "tool-result", toolCallId: ToolCallId.make("shot"), toolName: "shot", output: `a screenshot\n${mediaLabel(lost)}`, isError: false }])
  expect(entriesSendingMedia(entries, options)).toEqual([entryId(run, 0)])
})
