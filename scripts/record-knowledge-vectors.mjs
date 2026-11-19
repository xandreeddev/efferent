/**
 * Records the vectors the kernel's recall by meaning tests read (`packages/sdk/src/kernel/knowledge-meaning.test.ts`):
 * the memories of a small knowledge and the questions asked of it, embedded by the model the learn track's recall
 * lesson loads. The tests answer from the recording through `recordedEmbedder`, so no test loads a model.
 *
 * Each text is embedded alone (an 8-bit model scales its numbers for each batch), as a passage (`passage: ` before
 * it) for a memory's text and as a query (`query: `) for a question, mean pooled and normalized, each number rounded
 * to 4 places. It prints, for each question, the memories nearest to it by the rounded vectors, with their cosines:
 * what the tests assert.
 *
 * The library is the website's (`@huggingface/transformers`), resolved from its package; the first run downloads the
 * model (about 34 MB) to the library's local cache.
 *
 *   bun scripts/record-knowledge-vectors.mjs
 */
import { writeFile } from "node:fs/promises"
import { join } from "node:path"

const MODEL = "Xenova/e5-small-v2"
const DTYPE = "q8"
const OUT = join(import.meta.dir, "../packages/sdk/fixtures/knowledge-vectors.json")

/** The memories' texts, as the tests' knowledge holds them. */
const MEMORIES = [
  "Ana Silva works at Acme.",
  "Acme is in Lisbon.",
  "Ana Silva has parrot Pip.",
  "Ana Silva drinks green tea every morning.",
  "Bruno Reis lives in Porto.",
  "Bruno Reis plays chess on Sundays.",
  "Bruno Reis is allergic to peanuts.",
  "Carla Mendes teaches piano.",
  "Carla Mendes runs a bakery in Porto.",
]

/** The questions the tests ask. */
const QUESTIONS = [
  "Who keeps a bird?",
  "Where does Ana Silva work?",
  "Who gives music lessons?",
]

const { pipeline } = await import(Bun.resolveSync("@huggingface/transformers", join(import.meta.dir, "../packages/website")))
const extract = await pipeline("feature-extraction", MODEL, { dtype: DTYPE })
const rounded = (vector) => vector.map((number) => Math.round(number * 10_000) / 10_000)
const embedded = async (text, as) => rounded((await extract([`${as}: ${text}`], { pooling: "mean", normalize: true })).tolist()[0])

const vectors = { query: {}, passage: {} }
for (const text of MEMORIES) vectors.passage[text] = await embedded(text, "passage")
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
  const near = MEMORIES.map((text) => [cosine(vectors.query[question], vectors.passage[text]), text]).sort((a, b) => b[0] - a[0])
  console.log(question)
  for (const [score, text] of near.slice(0, 4)) console.log(`  ${score.toFixed(4)}  ${text}`)
}

const recording = {
  model: MODEL,
  note: `Recorded by scripts/record-knowledge-vectors.mjs with Transformers.js: ${MODEL}, ${DTYPE}, each text embedded alone with "passage: " or "query: " before it, mean pooled and normalized, each number rounded to 4 places.`,
  vectors,
}
await writeFile(OUT, `${JSON.stringify(recording)}\n`)
console.log(`wrote ${MEMORIES.length} passages and ${QUESTIONS.length} queries of ${vectors.passage[MEMORIES[0]].length} numbers`)
