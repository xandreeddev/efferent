// Lesson 14's failures.ts: what the model you picked does on its next
// calls, so the lesson can show a failure on any model. The read-only part
// says what an entry means and declares its type, `Failure`, the fields of
// the kernel's scripted model's `Fails` without its `_tag`; the learner edits
// the list. The page runs the list as written (an expression, as memory.ts's
// layer is), and program.test.ts compiles the whole file, the list held to
// its type.

/** Read-only: what the list says, the type of one entry, and the declaration the list completes. */
export const FAILURES_INTRO = `// What the model you picked does the next times it is asked: one entry each time, in order, so
// a call tried again takes an entry for each try. After the list, it answers as it does. Only
// the model you picked counts: the spare's tries do not.
// The page makes these failures, so the lesson can show them on any model: a call made to fail
// here never reaches the model, and the pieces it shows are the page's words.
// The list starts again whenever the program is built: Rebuild, Stop, Clear context, or another
// model picked.
type Failure = {
  // A failure worth another try: a provider's own error. Without it: an unknown error.
  readonly retryable?: boolean
  // The answer starts, shows these pieces, then fails. Without them: it fails before anything.
  readonly pieces?: ReadonlyArray<string>
}

export const failures: ReadonlyArray<Failure> = `

/** What the learner edits: the list. One failure worth another try, before anything: the next call is tried again. */
export const DEFAULT_FAILURES = "[{ retryable: true }]"

/** The whole file as the learner reads it, and as a test compiles it. */
export const failuresDocumentOf = (failures: string): string => `${FAILURES_INTRO}${failures}\n`
