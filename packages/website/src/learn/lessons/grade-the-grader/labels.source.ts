// Lesson 19's labels.ts: answers a person labelled by hand, each right or
// wrong. The learner edits all of it, as plain JavaScript the page runs as
// written. It imports nothing, and compiles as it is shown: a list of plain
// values needs no type written out.

/** What the learner edits: the eight labelled answers, as the lesson starts. */
export const DEFAULT_LABELS = `// The labels: answers a person read and marked by hand. Each is a question, the reference answer
// written beside it, an answer an agent might give, and the label: true when the answer is right,
// false when it is wrong. No grader sees a label: each grader is checked against them.
export const labels = [
  {
    id: "1",
    question: "What is 2 + 3?",
    reference: "5",
    answer: "2 + 3 = 5.",
    // A person wrote this label: right.
    label: true,
  },
  {
    id: "2",
    question: "What is 2 + 3?",
    reference: "5",
    answer: "Five.",
    // A person wrote this label: right, the number in words.
    label: true,
  },
  {
    id: "3",
    question: "What is the capital of Portugal?",
    reference: "Lisbon",
    answer: "Lisboa.",
    // A person wrote this label: right, the city's name in Portuguese.
    label: true,
  },
  {
    id: "4",
    question: "What is 2 + 3?",
    reference: "5",
    answer: "I think it might be 5, but I am not sure.",
    // A person wrote this label: right, though it hedges.
    label: true,
  },
  {
    id: "5",
    question: "What is 2 + 3?",
    reference: "5",
    answer: "5, because 2 + 3 is the same as 2 times 3.",
    // A person wrote this label: wrong, since the reason it gives is false.
    label: false,
  },
  {
    id: "6",
    question: "What is the capital of Portugal?",
    reference: "Lisbon",
    answer: "Lisbon, which is also the capital of Spain.",
    // A person wrote this label: wrong, since it says something false beside the answer.
    label: false,
  },
  {
    id: "7",
    question: "Where is the key?",
    reference: "under the mat",
    answer: "Probably under the mat or in the drawer.",
    // A person wrote this label: wrong, since it names two places and picks neither.
    label: false,
  },
  {
    id: "8",
    question: "What is the capital of Portugal?",
    reference: "Lisbon",
    answer: "Porto, not Lisbon.",
    // A person wrote this label: wrong, though the answer holds the word Lisbon.
    label: false,
  },
]`

/** Case 4's label as the file starts: right, though it hedges. The `hedge-is-wrong` experiment changes it. */
export const HEDGE_LABEL = `    // A person wrote this label: right, though it hedges.
    label: true,
`

/** The end of the list: the `your-own-case` experiment adds a case before it. */
export const LABELS_END = `  },
]`

/** The whole file as the learner reads it: there is nothing read-only around it. */
export const labelsDocumentOf = (labels: string): string => `${labels}\n`

/** The editable part as the page runs it: statements, without `export`. */
export const labelsBodyOf = (labels: string): string => labels.replace(/^export /gm, "")

/** The same file as a module a test compiles: the text as shown. */
export const labelsModuleOf = (labels: string): string => `${labels}\n`
