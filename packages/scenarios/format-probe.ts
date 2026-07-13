// E5 — output-format shootout: the SAME page content emitted in six formats,
// wall time + size + structural validity per model. Generation time is
// ~proportional to output tokens, but model FLUENCY in a format moves
// chars/s — so wall time for identical semantic content is the honest metric.
// Untracked experiment harness — not part of the battery.
import { homedir } from "node:os"
import { Duration, Effect, Option } from "effect"
import { LanguageModel } from "@effect/ai"
import { LanguageModelSelectionLive, LocalAuthStoreLive } from "@xandreed/providers"
import { CurrentModelCallPolicy, parseModelSelection } from "@xandreed/engine"

const CONTENT =
  "a landing page for an observability product for small teams: a hero (title, subtitle, one-paragraph body), a navigation (brand name + 4 links with label and target-section-id), a stats section (3 items, label + value), and a feature grid (4 items, title + one-sentence body)"

interface Fmt {
  readonly name: string
  readonly instruction: string
  readonly valid: (text: string) => boolean
}

const jsonParses = (text: string): boolean => {
  const attempt = Effect.try({ try: () => (JSON.parse(text.trim()) as unknown) !== null, catch: () => false })
  return Effect.runSync(attempt.pipe(Effect.orElseSucceed(() => false)))
}

const FORMATS: ReadonlyArray<Fmt> = [
  {
    name: "json",
    instruction:
      'Emit ONLY one JSON object (no prose, no fences): {"blocks":[{"kind":"hero","id":"...","title":"...","subtitle":"...","body":"..."},{"kind":"navigation","id":"...","brand":"...","links":[{"label":"...","target":"..."}]},{"kind":"stats","id":"...","items":[{"label":"...","value":"..."}]},{"kind":"feature-grid","id":"...","items":[{"title":"...","body":"..."}]}]}',
    valid: jsonParses,
  },
  {
    name: "ndjson",
    instruction:
      'Emit ONLY newline-delimited JSON (no prose, no fences): EXACTLY one JSON object per line, one line per block, in order hero, navigation, stats, feature-grid. Same fields as: {"kind":"hero","id":"...","title":"...","subtitle":"...","body":"..."} then {"kind":"navigation","id":"...","brand":"...","links":[{"label":"...","target":"..."}]} then {"kind":"stats","id":"...","items":[{"label":"...","value":"..."}]} then {"kind":"feature-grid","id":"...","items":[{"title":"...","body":"..."}]}',
    valid: (text) => {
      const lines = text.trim().split("\n").filter((line) => line.trim().length > 0)
      return lines.length >= 4 && lines.every(jsonParses)
    },
  },
  {
    name: "yaml",
    instruction:
      "Emit ONLY YAML (no prose, no fences): a top-level `blocks:` list; each item has kind, id, and the fields per kind — hero: title/subtitle/body; navigation: brand + links (list of label/target); stats: items (list of label/value); feature-grid: items (list of title/body).",
    valid: (text) => /^blocks:/m.test(text) && /kind:\s*hero/.test(text) && /kind:\s*(navigation|nav)/.test(text),
  },
  {
    name: "dsl",
    instruction:
      "Emit ONLY this indented component DSL (no prose, no fences). Grammar: a block opens with `<kind> <id>` on its own line; its fields are 2-space-indented `field: value` lines; list entries are 2-space-indented `- ` lines with 4-space-indented fields below. Blocks in order: hero, navigation, stats, feature-grid. Example shape:\nhero observability-hero\n  title: ...\n  subtitle: ...\n  body: ...\nnavigation main-nav\n  brand: ...\n  links:\n  - label: ...\n    target: ...\nstats key-stats\n  items:\n  - label: ...\n    value: ...\nfeature-grid features\n  items:\n  - title: ...\n    body: ...",
    valid: (text) =>
      /^hero [\w-]+$/m.test(text) && /^navigation [\w-]+$/m.test(text) && /^stats [\w-]+$/m.test(text) && /^feature-grid [\w-]+$/m.test(text),
  },
  {
    name: "html",
    instruction:
      'Emit ONLY custom-element markup (no prose, no fences, no head/body, no CSS/classes/attributes beyond id/target): <hero id="..."><title>...</title><subtitle>...</subtitle><body>...</body></hero><navigation id="..." brand="..."><link target="...">label</link>...</navigation><stats id="..."><stat label="...">value</stat>...</stats><feature-grid id="..."><feature title="...">body</feature>...</feature-grid>',
    valid: (text) =>
      /<hero /.test(text) && /<\/hero>/.test(text) && /<navigation /.test(text) && /<\/feature-grid>/.test(text) &&
      (text.match(/</g) ?? []).length === (text.match(/>/g) ?? []).length,
  },
  {
    name: "toon",
    instruction:
      "Emit ONLY TOON-style compact notation (no prose, no fences). Scalars as `key: value` indented under a block header `kind id`; uniform lists as a tabular header `items[N]{col1,col2}:` followed by N comma-separated rows. Blocks in order: hero, navigation (links[4]{label,target}), stats (items[3]{label,value}), feature-grid (items[4]{title,body}).",
    valid: (text) => /items\[\d+\]\{/.test(text) && /^hero /m.test(text),
  },
]

const MODELS = ["openai-codex:gpt-5.6-luna", "opencode:glm-5.1", "opencode:mimo-v2.5-pro"]
const SAMPLES = 2

const probe = (model: string, fmt: Fmt, sample: number) =>
  Effect.gen(function* () {
    const selection = Option.getOrThrow(parseModelSelection(model))
    const service = yield* LanguageModel.LanguageModel.pipe(
      Effect.provide(LanguageModelSelectionLive(selection, Option.none())),
      Effect.provide(LocalAuthStoreLive(process.cwd(), homedir())),
    )
    const t0 = Date.now()
    const done = yield* LanguageModel.generateText({ prompt: `${fmt.instruction}\n\nContent: ${CONTENT}` }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, service),
      Effect.locally(CurrentModelCallPolicy, Option.some({ effort: "low" as const, maxOutputTokens: 2600 })),
      Effect.timeout(Duration.seconds(60)),
      Effect.either,
    )
    const wall = Date.now() - t0
    if (done._tag === "Left") {
      console.log(`${model.padEnd(28)} ${fmt.name.padEnd(7)} s${sample} FAILED after ${wall}ms`)
      return { model, fmt: fmt.name, wall, chars: 0, ok: false }
    }
    const text = done.right.text
    const ok = fmt.valid(text)
    console.log(
      `${model.padEnd(28)} ${fmt.name.padEnd(7)} s${sample} ${String(wall).padStart(6)}ms · ${String(text.length).padStart(5)} chars · ${String(Math.round((text.length / wall) * 1000)).padStart(4)} c/s · valid=${ok}`,
    )
    return { model, fmt: fmt.name, wall, chars: text.length, ok }
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync(() => {
        console.log(`${model} ${fmt.name} s${sample} ERROR: ${String(e).slice(0, 80)}`)
        return { model, fmt: fmt.name, wall: 0, chars: 0, ok: false }
      }),
    ),
  )

const cases = MODELS.flatMap((model) =>
  FORMATS.flatMap((fmt) => Array.from({ length: SAMPLES }, (_, index) => ({ model, fmt, sample: index + 1 }))),
)

const all = await Effect.runPromise(
  Effect.forEach(cases, ({ model, fmt, sample }) => probe(model, fmt, sample), { concurrency: 4 }),
)
console.log("\n=== per model×format means (valid runs only) ===")
MODELS.forEach((model) => {
  FORMATS.forEach((fmt) => {
    const runs = all.filter((r) => r.model === model && r.fmt === fmt.name && r.ok)
    const failures = all.filter((r) => r.model === model && r.fmt === fmt.name && !r.ok).length
    const meanWall = runs.length === 0 ? 0 : Math.round(runs.reduce((sum, r) => sum + r.wall, 0) / runs.length)
    const meanChars = runs.length === 0 ? 0 : Math.round(runs.reduce((sum, r) => sum + r.chars, 0) / runs.length)
    console.log(
      `${model.padEnd(28)} ${fmt.name.padEnd(7)} valid ${runs.length}/${runs.length + failures} · mean ${String(meanWall).padStart(6)}ms · ${String(meanChars).padStart(5)} chars`,
    )
  })
})
