// Echo as a curator (lesson 18): it answers the kernel's curation prompt by
// rule, narrowly, as it answers everything, so the lesson's page can rely on
// it with no model. The rule is asleep unless the prompt is the kernel's,
// read by its first line word for word: the kernel's words are never changed
// for Echo. It reads the `<this-turn>` block's `User:` lines for what to keep,
// and the prompt's `<stored-entities>` and `<stored-memories>`, so it reuses
// what is stored. It over-reaches in one way, on purpose: after a question,
// it also proposes a sentence of the assistant's answer as a memory, quoting
// the assistant, and the kernel's checks drop it (the assistant's words are
// no evidence). It also reads the kernel's note of memories
// (`knowledgeNote`) for the chat: a question sent with one is answered from
// the note's first memory and what the note says about it.
import { curationPrompt, knowledgeNote, reviewPrompt, USER_NAME } from "@xandreed/sdk/kernel"

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
 * between its two things is a memory about the two.
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
 * memory already says, word for word, is a restatement. Earlier turns are never read. The assistant's answer is read
 * only after a question, and only to over-reach: its first sentence about two stored things is proposed too, quoting
 * the assistant, for the kernel's checks to drop.
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
  // A question's turn: the assistant's answer is read too, as a curator that over-reaches would read it. Its first
  // sentence about two things already stored is proposed as a memory, quoting the assistant, and the kernel's checks
  // drop it: its quote is in nothing the user said. Only things already stored, so a dropped memory leaves no entity.
  if (said.some((text) => text.trim().endsWith("?"))) {
    const answer = (framedIn("this-turn", prompt) ?? "").split("\n").find((line) => line.startsWith(ANSWER))?.slice(ANSWER.length) ?? ""
    const guessed = answer.split(/(?<=[.!?])\s+/).flatMap((sentence): ReadonlyArray<Proposed> => {
      const quote = sentence.trim()
      // "From what I know: Ana Silva works at Acme." reads as the sentence after its colon.
      const found = SAID.exec(quote.replace(/^[^:]*:\s+/, "").replace(/[.!]+$/, "").trim())
      const relation = found?.[3]?.toLowerCase()
      if (found === null || relation === undefined || quote.endsWith("?")) return []
      const subjectName = (found[1] ?? "").trim()
      const objectName = (found[4] ?? "").trim()
      const subject = known(subjectName)
      const object = known(objectName)
      if (subject === undefined || object === undefined) return []
      return [{ kind: relation === "likes" ? "preference" : "fact", text: `${subjectName} ${relation} ${objectName}.`, about: [subject, object], quote, by: "user", on: null, ends: [], why: null }]
    })
    memories.push(...guessed.slice(0, 1))
  }
  return JSON.stringify({ entities, aliases: [], memories, restates, forget })
}

/** The label of the assistant's line in a source, as the kernel's `sourceText` writes it. */
const ANSWER = "Assistant's final answer: "

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

/** One memory of a note as Echo reads it: its sentence without when it was said, and the sentences of what it replaced. */
export interface NoteMemory {
  readonly text: string
  readonly before: ReadonlyArray<string>
}

/** The memories of the last note of memories among `notes`, in order, each with the lines of what it replaced. */
export const memoriesIn = (notes: ReadonlyArray<string>): ReadonlyArray<NoteMemory> => {
  const note = notes.findLast(isMemoriesNote)
  if (note === undefined) return []
  const read: Array<NoteMemory> = []
  for (const line of note.slice(MEMORIES_OPEN.length, note.length - MEMORIES_CLOSE.length).split("\n")) {
    const before = /^ {2}before that: (.+)$/.exec(line)
    const text = (before === null ? line : before[1] ?? "").replace(WHEN_SAID, "")
    const last = read.at(-1)
    if (text.length === 0) continue
    if (before === null) read.push({ text, before: [] })
    else if (last !== undefined) read[read.length - 1] = { text: last.text, before: [...last.before, text] }
  }
  return read
}

/**
 * The names a memory's sentence says, as `plain` compares them: each run of words that start with a capital letter
 * ("Ana Silva", "Project Pebble III"), and the user, for a sentence that starts with "The user". The note holds no
 * ids, so Echo reads the names from the words.
 */
export const namesIn = (sentence: string): ReadonlyArray<string> => {
  const words = sentence.replace(/[.!?]+$/, "").split(/\s+/).map((word) => word.replace(/[,;:]+$/, ""))
  const user = plain(USER_NAME)
  const names: Array<string> = plain(words.slice(0, 2).join(" ")) === user ? [user] : []
  let run: Array<string> = []
  const close = () => {
    if (run.length > 0) names.push(plain(run.join(" ")))
    run = []
  }
  for (const word of names.length > 0 ? words.slice(2) : words) {
    if (/^\p{Lu}/u.test(word)) run.push(word)
    else close()
  }
  close()
  return [...new Set(names)]
}

/** Whether a text holds a name as a run of whole words, both as `plain` has them. */
const holds = (text: string, name: string): boolean => ` ${plain(text)} `.includes(` ${name} `)

/** Whether two words meet as the kernel's recall has them meet: the same, or both four letters or more and one starts the other. */
const meet = (one: string, other: string): boolean =>
  one === other || (one.length >= 4 && other.length >= 4 && (one.startsWith(other) || other.startsWith(one)))

/**
 * What Echo says from a note of memories, for a question: the note's first memory, then up to two other memories of
 * the note about a thing the first one names and the question does not (Acme, from "Ana Silva works at Acme.", for a
 * question about Ana Silva), those that share a word with the question first, then in the note's order. A memory's
 * "before that" lines follow it, each as "Before that: <sentence>", and take no place.
 */
export const answerFromNote = (question: string, memories: ReadonlyArray<NoteMemory>): ReadonlyArray<string> => {
  const [first, ...rest] = memories
  if (first === undefined) return []
  const unasked = namesIn(first.text).filter((name) => !holds(question, name))
  const about = rest.filter((memory) => namesIn(memory.text).some((name) => unasked.includes(name)))
  const asked = plain(question).split(" ")
  const shares = (memory: NoteMemory) => plain(memory.text).split(" ").some((word) => asked.some((one) => meet(one, word)))
  const picked = [...about.filter(shares), ...about.filter((memory) => !shares(memory))].slice(0, 2)
  return [first, ...picked].flatMap((memory) => [memory.text, ...memory.before.map((text) => `Before that: ${text}`)])
}
