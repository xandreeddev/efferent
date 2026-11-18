/**
 * Records the vectors the kernel's recall tests read (`packages/sdk/src/kernel/recall.test.ts`): a small world of
 * links and facts, and the questions asked of it, embedded by the model the learn track's recall lesson runs. The
 * sdk's tests answer from the recording through `recordedEmbedder`, so no test loads a model.
 *
 * Each text is embedded alone (an 8-bit model scales its numbers for each batch), as a passage (`passage: ` before
 * it) for an item and as a query (`query: `) for a question, mean pooled and normalized, each number rounded to 4
 * places. The texts are the kernel's own (`recallText`), so a key the tests make finds its vector. It prints, for each
 * question, the passages nearest to it, by the rounded vectors, with their cosines: what the tests assert.
 *
 * The first run downloads the model (about 34 MB) to the library's local cache.
 *
 *   bun scripts/record-recall-vectors.mjs
 */
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pipeline } from "@huggingface/transformers"
import { recallText } from "@xandreed/sdk/kernel"

const MODEL = "Xenova/e5-small-v2"
const DTYPE = "q8"
const OUT = join(import.meta.dir, "../../sdk/fixtures/recall-vectors.json")

/** The links of the world, as `linkThings` would store them: subject, relation, object. */
const LINKS = [
  ["Ana Silva", "works at", "Acme"],
  ["Ana Silva", "lives in", "Lisbon"],
  ["Ana Silva", "owns", "a red bicycle"],
  ["Acme", "makes", "garden tools"],
  ["Acme", "is in", "Braga"],
  ["Bruno Reis", "works at", "Globex"],
  ["Bruno Reis", "is married to", "Carla Mendes"],
  ["Bruno Reis", "speaks", "German"],
  ["Carla Mendes", "lives in", "Porto"],
  ["Carla Mendes", "teaches", "piano"],
  ["Globex", "is in", "Madrid"],
  ["Dan Costa", "works at", "Initech"],
  ["Initech", "sells", "accounting software"],
  ["Eva Novak", "plays", "chess"],
  ["Eva Novak", "is the sister of", "Ana Silva"],
]

/** The facts of the world, as `rememberFact` would store them. One says what a link says. */
const FACTS = [
  "Carla Mendes lives in Porto.",
  "Eva Novak starts every day with a cup of green tea.",
  "Bruno Reis is allergic to peanuts.",
  "Ana Silva's birthday is on the third of March.",
  "Dan Costa takes his coffee black.",
  "The team meeting moved to Thursday afternoons.",
  "Bruno Reis cycles to the office since October.",
  "Eva Novak is learning Japanese.",
  "Ana Silva prefers window seats on flights.",
  "The office closes early on Fridays.",
]

/** The questions the tests ask. */
const QUESTIONS = [
  "Who employs Ana Silva?",
  "What can Bruno Reis not eat?",
  "Where is the home of Carla Mendes?",
  "Which company is Dan Costa employed by?",
  "How does Dan Costa like his coffee?",
]

const items = [
  ...LINKS.map(([subject, relation, object], at) => ({
    _tag: "Link",
    said: { link: { id: `e${at + 1}`, subject, relation, object, from: { session: "world", turn: 1 } }, count: 1, last: 0 },
  })),
  ...FACTS.map((text, at) => ({ _tag: "Fact", fact: { id: `f${at + 1}`, text, from: { session: "world", turn: 1 } }, at: 0 })),
]
const passages = [...new Set(items.map(recallText))]

const extract = await pipeline("feature-extraction", MODEL, { dtype: DTYPE })
const rounded = (vector) => vector.map((number) => Math.round(number * 10_000) / 10_000)
const embedded = async (text, as) => rounded((await extract([`${as}: ${text}`], { pooling: "mean", normalize: true })).tolist()[0])

const vectors = { query: {}, passage: {} }
for (const text of passages) vectors.passage[text] = await embedded(text, "passage")
for (const text of QUESTIONS) vectors.query[text] = await embedded(text, "query")

const cosine = (a, b) => {
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return dot / Math.sqrt(aa * bb)
}
for (const question of QUESTIONS) {
  const near = passages.map((text) => [cosine(vectors.query[question], vectors.passage[text]), text]).sort((a, b) => b[0] - a[0])
  console.log(question)
  for (const [score, text] of near.slice(0, 5)) console.log(`  ${score.toFixed(4)}  ${text}`)
}

const recording = {
  model: MODEL,
  note: `Recorded by packages/website/scripts/record-recall-vectors.mjs with Transformers.js: ${MODEL}, ${DTYPE}, each text embedded alone with "passage: " or "query: " before it, mean pooled and normalized, each number rounded to 4 places.`,
  world: { links: LINKS.map(([subject, relation, object]) => ({ subject, relation, object })), facts: FACTS, questions: QUESTIONS },
  vectors,
}
await writeFile(OUT, `${JSON.stringify(recording)}\n`)
console.log(`wrote ${passages.length} passages and ${QUESTIONS.length} queries of ${vectors.passage[passages[0]].length} numbers`)
