// Lesson 8's controls and experiments edit the learner's code in place, so
// the code and the controls never disagree. A line the learner rewrote
// beyond recognition is left alone (None) rather than guessed at.
import { Option } from "effect"
import { NEW_COMMENT, READ_AS_STORED, READ_WITH_RULE, RULE } from "./memory.source.ts"

const overLine = /(overTokens: )(\d+)/
const previewLine = /(previewTokens: )(\d+)/

const readNumber = (line: RegExp) => (memory: string): Option.Option<number> =>
  Option.map(Option.fromNullishOr(line.exec(memory)?.[2]), Number)

/**
 * A number written where the line holds one: a whole number of at least one, as lesson 5's budget is (a field
 * emptied while typing reads as zero, and writes nothing). A pair `pointed` refuses, a preview not shorter than
 * the size, is written as asked: the refusal is the program's to say, in the kernel's words.
 */
const writeNumber = (line: RegExp) => (memory: string, tokens: number): Option.Option<string> =>
  line.test(memory) && Number.isInteger(tokens) && tokens >= 1
    ? Option.some(memory.replace(line, (_all, head: string) => `${head}${tokens}`))
    : Option.none()

/** memory.ts's size: a tool result estimated over this many tokens is sent as a pointer. */
export const readOver = readNumber(overLine)
export const writeOver = writeNumber(overLine)

/** memory.ts's preview: how many tokens of a long result's start are sent with its pointer. */
export const readPreview = readNumber(previewLine)
export const writePreview = writeNumber(previewLine)

/** The preview the `tiny-preview` experiment sets: five tokens, twenty characters. */
export const TINY_PREVIEW = 5

/** Replace one exact piece of code, or None when it is not there. */
const swap = (from: string, to: string) => (source: string): Option.Option<string> =>
  source.includes(from) ? Option.some(source.replace(from, to)) : Option.none()

/** The rule's statement and the blank line under it, as memory.ts writes them, whatever its two numbers are now. */
const RULE_LINES = new RegExp(`${RULE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/(Tokens: )\d+/g, "$1\\d+")}\n`)

/**
 * memory.ts without the rule: its statement and its comment go, the line that said what is new goes, and each
 * record is read with `messageOf` again. What is left is lesson 2's memory: every result whole, in every prompt.
 * The controls then have no line to write.
 */
export const noPointers = (memory: string): Option.Option<string> =>
  RULE_LINES.test(memory) && memory.includes(NEW_COMMENT) && memory.includes(READ_WITH_RULE)
    ? Option.some(memory.replace(RULE_LINES, "").replace(NEW_COMMENT, "").replace(READ_WITH_RULE, () => READ_AS_STORED))
    : Option.none()

/**
 * memory.ts points only the turns before the open one: the model sees a whole result in the turn that fetched it,
 * and what is sent for that record changes at the next turn.
 */
export const olderTurns = (memory: string): Option.Option<string> =>
  Option.flatMap(swap(NEW_COMMENT, "// One thing is new: a record of an earlier turn is read with the rule above.\n")(memory), swap(READ_WITH_RULE, `        // Only the turns before this one are pointed: a result of the open turn is sent whole.
        const messages = conversation.flatMap((record) =>
          Option.toArray(record.turn < session.turn ? sent(record) : messageOf(record)),
        )
`))

/** tools.ts's toolkit and the kernel's handler, as it writes them. */
const OFFERED = `// ReadResult is the kernel's tool: it reads a part of a stored result, from the place a pointer
// names. A program whose memory sends pointers offers it beside its own tools.
export const tools = Toolkit.make(lookup, ReadResult)
`
const NOT_OFFERED = `// ReadResult, the kernel's tool that reads on from a pointer, is not offered here. Memory still
// sends pointers: they name a tool the model does not have.
export const tools = Toolkit.make(lookup)
`
const HANDLER = `  // The kernel's handler: it reads the result from the journal of the turn its call runs in.
  readResult,
`

/** tools.ts without `ReadResult` and its handler: memory still sends pointers, which name a tool the model does not have. */
export const noReadResult = (tools: string): Option.Option<string> =>
  Option.flatMap(swap(OFFERED, NOT_OFFERED)(tools), swap(HANDLER, ""))
