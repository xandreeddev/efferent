// Lesson 8's memory.ts: lesson 2's flat memory with one function changed.
// Each record's message is read with the function `pointed` gives, where
// lesson 2 called `messageOf`: a tool's long result is sent as its start and
// a pointer, and the journal keeps it whole.
//
// How the text is composed. The file is statements, as tools.ts is: the
// rule first, made once (`const sent = pointed(…)`), then the layer. The
// rule is this lesson's own text. Everything else is lesson 2's with named
// pieces replaced: its imports (`pointed` joins them), its comment and
// declaration (one line says what is new), and its layer (the line that
// reads each record). program.test.ts checks lesson 2's texts still hold
// each piece. Lesson 2's file is one expression after a read-only
// declaration; here the declaration is part of what the learner edits, since
// the rule is a statement above it.
import { replaced } from "../base/agent.source.ts"
import { DEFAULT_MEMORY as FLAT_MEMORY, MEMORY_IMPORTS as FLAT_IMPORTS, MEMORY_INTRO as FLAT_INTRO } from "../tools/memory.source.ts"

const FLAT_KERNEL = 'import { Memory, paired, promptMessage } from "@xandreed/sdk"'
const OUR_KERNEL = 'import { Memory, paired, pointed, promptMessage } from "@xandreed/sdk"'

/** What this lesson replaces in lesson 2's imports, as `[from, to]`: `pointed` joins them. */
export const REPLACED_IMPORTS: ReadonlyArray<readonly [string, string]> = [[FLAT_KERNEL, OUR_KERNEL]]

/** Read-only: where each name the memory uses comes from. `messageOf` stays: two experiments read a record with it. */
export const MEMORY_IMPORTS = replaced(FLAT_IMPORTS, REPLACED_IMPORTS)

/** Everything before the editable part. */
export const MEMORY_HEADER = `${MEMORY_IMPORTS}\n\n`

/** The rule, a statement of the file: made once, as the file runs, so numbers `pointed` refuses refuse the build. */
export const RULE = `// A long tool result is sent as its start and a pointer: the journal keeps it whole.
// Over \`overTokens\` a result is long; \`previewTokens\` of its start go with the pointer.
// The rule reads only the record, so a result is sent the same way in every prompt.
const sent = pointed({ overTokens: 150, previewTokens: 40 })
`

/** Lesson 2's comment and declaration: what its read-only start holds after its imports and the blank line. */
export const FLAT_DECLARATION = FLAT_INTRO.slice(FLAT_IMPORTS.length + 2)

const FLAT_COMMENT = "// This one is flat: every message of the conversation so far, oldest first, tool calls and results included.\n"

/** The line this lesson adds under lesson 2's comment. */
export const NEW_COMMENT = "// One thing is new: each record's message is read with the rule above, not with messageOf.\n"

/** What this lesson replaces in lesson 2's comment and declaration, as `[from, to]`: one line says what is new. */
export const REPLACED_DECLARATION: ReadonlyArray<readonly [string, string]> = [[FLAT_COMMENT, `${FLAT_COMMENT}${NEW_COMMENT}`]]

/** How lesson 2 reads each record's message. */
export const READ_AS_STORED = "        const messages = conversation.flatMap((record) => Option.toArray(messageOf(record)))\n"

/** The same line with the rule. */
export const READ_WITH_RULE = "        const messages = conversation.flatMap((record) => Option.toArray(sent(record)))\n"

/** What this lesson replaces in lesson 2's layer, as `[from, to]`: the function each record's message is read with. */
export const REPLACED: ReadonlyArray<readonly [string, string]> = [[READ_AS_STORED, READ_WITH_RULE]]

/** What the learner edits: the rule, then lesson 2's flat memory reading each record with it. */
export const DEFAULT_MEMORY = `${RULE}\n${replaced(FLAT_DECLARATION, REPLACED_DECLARATION)}${replaced(FLAT_MEMORY, REPLACED)}`

/** The whole file as the learner reads it. */
export const memoryDocumentOf = (memory: string): string => `${MEMORY_HEADER}${memory}\n`

/** The same file as a module a test can compile: nothing in it needs a type. */
export const memoryModuleOf = (memory: string): string => `${MEMORY_HEADER}${memory}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const memoryBodyOf = (memory: string): string => memory.replace(/^export /gm, "")
