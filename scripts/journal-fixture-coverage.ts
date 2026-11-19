/**
 * What a recorded journal fixture must hold (scripts/record-journal-fixture.ts refuses to write one that misses any),
 * as pure functions over the journals the recording stored. journal-fixture-coverage.test.ts covers them.
 */
import type { Journal, StoredEvent } from "@xandreed/core/kernel"
import { estimateTokens, messageText } from "@xandreed/sdk/kernel"

/** One kind of record the fixture is meant to hold: its name in a refusal, and whether a record is one. */
export interface Required { readonly name: string; readonly is: (event: StoredEvent) => boolean }

const named = (name: string): Required => ({ name, is: (event) => event.name === name })

/** Every kind of record a fixture holds, so the compatibility test replays each. */
export const REQUIRED: ReadonlyArray<Required> = [
  { name: "a tool call (conversation.assistant.message with toolCalls)", is: (event) => event.name === "conversation.assistant.message" && event.message?._tag === "Assistant" && event.message.toolCalls.length > 0 },
  named("conversation.tool.result"),
  { name: "an approval for good (plugin.approval.decided, ApprovedAlways)", is: (event) => event.name === "plugin.approval.decided" && JSON.stringify(event.data).includes('"_tag":"ApprovedAlways"') },
  named("plugin.facts.learned"),
  named("plugin.summary.summarized"),
  named("plugin.knowledge.source"),
  named("plugin.knowledge.entity"),
  named("plugin.knowledge.memory"),
  named("plugin.knowledge.ended"),
  named("plugin.knowledge.curated"),
]

/**
 * The recording's summary memory's budget: well under what the turns hold together, so its summary is asked for
 * whatever a note or a prompt's words add or take (the recorder refuses a margin under `SUMMARY_PRESSURE`), and well
 * over any one turn with a summary beside it, so the open turn always fits.
 */
export const SUMMARY_BUDGET = 150
/** The least the conversation's messages may hold, as a multiple of `SUMMARY_BUDGET`. */
export const SUMMARY_PRESSURE = 1.4

/** The kinds of `required` no journal of the recording holds, by name. */
export const missingRecords = (journals: ReadonlyArray<Journal>, required: ReadonlyArray<Required> = REQUIRED): ReadonlyArray<string> => {
  const events = journals.flatMap((journal) => journal.events)
  return required.filter((kind) => !events.some(kind.is)).map((kind) => kind.name)
}

/**
 * How far over the summary memory's budget the conversation's messages are, as a ratio: what the memory would send
 * with nothing folded, as it counts it (a message's text, tool calls and results included), over the budget. The
 * recorder asks for a wide margin, so a note or a prompt reworded a little cannot leave the recording with no summary.
 */
export const summaryPressure = (journals: ReadonlyArray<Journal>, budgetTokens: number): number => {
  const conversation = journals.find((journal) => journal.events.some((event) => event.name === "plugin.summary.summarized"))
    ?? journals.find((journal) => journal.events.some((event) => event.name.startsWith("conversation.")))
  const tokens = (conversation?.events ?? []).reduce((sum, event) =>
    event.message !== undefined && event.name.startsWith("conversation.") ? sum + estimateTokens(messageText(event.message)) : sum, 0)
  return tokens / budgetTokens
}
