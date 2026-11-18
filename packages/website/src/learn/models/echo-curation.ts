// Echo as a curator (lesson 18): it answers the kernel's curation prompt by
// rule, narrowly, as it answers everything, so the lesson's page can rely on
// it with no model. The rule is asleep unless the prompt is the kernel's,
// read by its first line word for word: the kernel's words are never changed
// for Echo. It reads the `<this-turn>` block's `User:` lines alone, so it
// never rests a memory on the assistant's words, and the prompt's
// `<stored-entities>` and `<stored-memories>`, so it reuses what is stored.
// It also reads the kernel's note of memories (`knowledgeNote`) for the chat:
// a question sent with one is answered from its first two lines.
import { curationPrompt, knowledgeNote, reviewPrompt } from "@xandreed/sdk/kernel"

/** The text inside `<tag>…</tag>`, when a text frames one. */
const framedIn = (tag: string, text: string): string | undefined => new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1]

/** The first line of the kernel's curation prompt, word for word: the task. */
export const CURATION_HEAD = curationPrompt({ said: [{ by: "user", text: "." }], at: 0 }, { entities: [], memories: [] }).split("\n")[0] ?? ""
/** The first line of the kernel's review prompt, word for word. */
export const REVIEW_HEAD = reviewPrompt("", "").split("\n")[0] ?? ""

/** Whether a text is the kernel's curation prompt: its first line, then more. */
export const isCurationPrompt = (text: string): boolean => text.startsWith(`${CURATION_HEAD}\n`)
/** Whether a text is the kernel's review prompt: its first line, then more. */
export const isReviewPrompt = (text: string): boolean => text.startsWith(`${REVIEW_HEAD}\n`)

/**
 * The relations Echo reads a memory in, and no other: a sentence "<thing> <relation> <thing>." with one of these
 * between its two things is a memory about the two. The same list as Echo's links (lesson 18 before the curator).
 */
export const MEMORY_RELATIONS = ["works at", "is in", "lives in", "likes", "drives", "sells", "is the sister of"] as const

/** What the person says of themself, as the relation it is: "I work at X." is "the user works at X.". */
const SPEAKER_RELATIONS: Readonly<Record<string, string>> = {
  "work at": "works at", "live in": "lives in", like: "likes", drive: "drives", sell: "sells", "am the sister of": "is the sister of",
}

/** A sentence about two things: its subject, whether it says "now", its relation, its object. */
const SAID = new RegExp(`^(.+?)\\s+(now\\s+)?(${MEMORY_RELATIONS.join("|")})\\s+(.+)$`, "i")
/** A sentence of the person's about themself: "I live in Porto.", "I now work at Globex.". */
const SPEAKER = new RegExp(`^I\\s+(now\\s+)?(${Object.keys(SPEAKER_RELATIONS).join("|")})\\s+(.+)$`, "i")
/** "Forget Ana Silva.": the stored memories about her are to be forgotten. */
const FORGET = /^forget\s+(.+)$/i
/** "My friend Ana Silva", "my sister Eva": the person, by name. */
const MY = /^my\s+[a-z-]+\s+(?=\S)/i

/** The kinds a new entity takes, by the relation's two places: the subject's, then the object's. */
const KINDS: Readonly<Record<(typeof MEMORY_RELATIONS)[number], readonly [string, string]>> = {
  "works at": ["person", "organization"],
  "is in": ["thing", "place"],
  "lives in": ["person", "place"],
  likes: ["person", "thing"],
  drives: ["person", "thing"],
  sells: ["organization", "thing"],
  "is the sister of": ["person", "person"],
}

/** A text as names are compared: lower case, one space between words, no punctuation. */
const plain = (text: string): string => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()

/** A stored entity as the prompt lists it: `n3: Ana Silva (person; also called Ana)`. */
interface Listed {
  readonly id: string
  readonly names: ReadonlyArray<string>
}

/** A stored memory as the prompt lists it: `m1: Ana Silva works at Acme. [fact; about n2, n3; said on …]`, and whether it ended. */
interface Kept {
  readonly id: string
  readonly text: string
  readonly about: ReadonlyArray<string>
  readonly ended: boolean
}

const entitiesIn = (prompt: string): ReadonlyArray<Listed> =>
  (framedIn("stored-entities", prompt) ?? "").split("\n").flatMap((line) => {
    const found = /^(n[1-9][0-9]*): (.+) \([^;)]+(?:; also called (.+))?\)$/.exec(line)
    return found === null ? [] : [{ id: found[1] ?? "", names: [found[2] ?? "", ...(found[3] === undefined ? [] : found[3].split(", "))] }]
  })

const memoriesListed = (prompt: string): ReadonlyArray<Kept> =>
  (framedIn("stored-memories", prompt) ?? "").split("\n").flatMap((line) => {
    const found = /^(m[1-9][0-9]*): (.+) \[[^;]+; about ([^;]+); said [^\]]+?(; ended on [0-9-]+)?\]$/.exec(line)
    return found === null ? [] : [{ id: found[1] ?? "", text: found[2] ?? "", about: found[3] === "nobody" ? [] : (found[3] ?? "").split(", "), ended: found[4] !== undefined }]
  })

/** One memory of the reply, in the shape the prompt asks for. */
interface Proposed {
  readonly kind: string
  readonly text: string
  readonly about: ReadonlyArray<string>
  readonly quote: string
  readonly by: "user"
  readonly on: null
  readonly ends: ReadonlyArray<string>
  readonly why: "changed" | null
}

/**
 * What Echo answers the kernel's curation prompt with, by rule. In the `<this-turn>` block's `User:` lines, each
 * sentence "<thing> <relation> <thing>." with a relation of `MEMORY_RELATIONS` is a memory about the two, the
 * subject first in `about`, quoting the sentence; "My friend Ana Silva" is Ana Silva. A thing the prompt's
 * `<stored-entities>` holds, by its name or another name, is that entity; any other is a new one, under a key of
 * its own, its kind from its place in the relation ("works at": a person and an organization; "lives in" and
 * "is in": the object a place; "is the sister of": two people; anything else a thing), never from capitals. "I …"
 * sentences are about the user (`n1`). "X now <relation> Y." also ends the stored memory about X with the same
 * relation that stands. "Forget X." lists the standing memories about X in `forget`. A sentence a standing stored
 * memory already says, word for word, is a restatement. Nothing else is read: never the assistant's words, and
 * never the earlier turns.
 */
export const echoCuration = (prompt: string): string => {
  const said = (framedIn("this-turn", prompt) ?? "").split("\n").flatMap((line) => (line.startsWith("User: ") ? [line.slice("User: ".length)] : []))
  const stored = entitiesIn(prompt)
  const kept = memoriesListed(prompt)
  const standing = kept.filter((memory) => !memory.ended)
  const entities: Array<{ readonly key: string; readonly name: string; readonly kind: string }> = []
  const memories: Array<Proposed> = []
  const restates: Array<{ readonly id: string; readonly quote: string }> = []
  const forget: Array<string> = []
  /** The stored entity a name is, by its name or another name, or the new one this reply proposes under it. */
  const known = (name: string): string | undefined =>
    stored.find((entity) => entity.names.some((one) => plain(one) === plain(name)))?.id ?? entities.find((entity) => plain(entity.name) === plain(name))?.key
  const entityOf = (name: string, kind: string): string => {
    const found = known(name)
    if (found !== undefined) return found
    const key = String.fromCharCode(97 + entities.length)
    entities.push({ key, name, kind })
    return key
  }
  for (const text of said) {
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const quote = sentence.trim()
      // A question says nothing to keep.
      if (quote.length === 0 || quote.endsWith("?")) continue
      const bare = quote.replace(/[.!]+$/, "").trim()
      const forgotten = FORGET.exec(bare)
      if (forgotten !== null) {
        const id = known(forgotten[1]?.trim() ?? "")
        if (id !== undefined) for (const memory of standing) if (memory.about.includes(id) && !forget.includes(memory.id)) forget.push(memory.id)
        continue
      }
      const self = SPEAKER.exec(bare)
      const other = self === null ? SAID.exec(bare) : null
      const relation = self !== null ? SPEAKER_RELATIONS[(self[2] ?? "").toLowerCase()] : other?.[3]?.toLowerCase()
      if (relation === undefined || !(MEMORY_RELATIONS as ReadonlyArray<string>).includes(relation)) continue
      const kinds = KINDS[relation as (typeof MEMORY_RELATIONS)[number]]
      const now = (self ?? other)?.[self !== null ? 1 : 2] !== undefined
      const subjectName = self !== null ? "The user" : (other?.[1] ?? "").trim().replace(MY, "")
      const objectName = ((self !== null ? self[3] : other?.[4]) ?? "").trim()
      const subject = self !== null ? "n1" : entityOf(subjectName, kinds[0])
      const sentenceText = `${subjectName} ${relation} ${objectName}.`
      const again = standing.find((memory) => plain(memory.text) === plain(sentenceText))
      if (again !== undefined) {
        restates.push({ id: again.id, quote })
        continue
      }
      const object = entityOf(objectName, kinds[1])
      // "X now works at Y.": what X held before under the same relation is over.
      const ends = now ? standing.filter((memory) => memory.about[0] === subject && plain(memory.text).includes(` ${plain(relation)} `)).map((memory) => memory.id) : []
      memories.push({
        kind: relation === "likes" ? "preference" : "fact", text: sentenceText, about: [subject, object], quote, by: "user", on: null,
        ends, why: ends.length > 0 ? "changed" : null,
      })
    }
  }
  return JSON.stringify({ entities, aliases: [], memories, restates, forget })
}

/** What Echo answers the kernel's review prompt with: the proposal it was given, unchanged. */
export const echoReview = (prompt: string): string => framedIn("proposed-update", prompt) ?? "{}"

/**
 * The first line of the kernel's note of memories, word for word: a message that starts with it and frames its
 * lines lists what `withKnowledge` sent for this request.
 */
const MEMORIES_HEAD = knowledgeNote([]).split("\n")[0] ?? ""
const MEMORIES_OPEN = `${MEMORIES_HEAD}\n<known-memories>\n`
const MEMORIES_CLOSE = "\n</known-memories>"

/** Whether a text is the kernel's note of memories: its first line, then the frame, and nothing after it. */
export const isMemoriesNote = (text: string): boolean => text.startsWith(MEMORIES_OPEN) && text.endsWith(MEMORIES_CLOSE)

/** What the note writes after a memory's sentence: when it was said, and for one it replaced, until when it held. */
const WHEN_SAID = / \(said (?:on [0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]+ times, last [0-9]{4}-[0-9]{2}-[0-9]{2})(?:, until [0-9]{4}-[0-9]{2}-[0-9]{2})?\)$/

/**
 * The lines of the last note of memories among `notes`, in order, each as Echo quotes it: its sentence without the
 * bracket after it, and a line of what a memory replaced as "Before that: <sentence>".
 */
export const memoriesIn = (notes: ReadonlyArray<string>): ReadonlyArray<string> => {
  const note = notes.findLast(isMemoriesNote)
  if (note === undefined) return []
  return note.slice(MEMORIES_OPEN.length, note.length - MEMORIES_CLOSE.length).split("\n").flatMap((line) => {
    const before = /^ {2}before that: (.+)$/.exec(line)
    const text = (before === null ? line : before[1] ?? "").replace(WHEN_SAID, "")
    return text.length === 0 ? [] : [before === null ? text : `Before that: ${text}`]
  })
}
