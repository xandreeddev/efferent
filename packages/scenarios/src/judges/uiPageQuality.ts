import { Effect, Schema } from "effect"
import type { UiPage } from "@xandreed/ui-agent"
import type { Judge } from "../framework/model.js"

export const UI_PAGE_QUALITY_RUBRIC_VERSION = "2.0.0"

const Grades = Schema.parseJson(Schema.Struct({
  hierarchy: Schema.Number,
  informationArchitecture: Schema.Number,
  specificity: Schema.Number,
  designSystem: Schema.Number,
  composition: Schema.Number,
  interaction: Schema.Number,
  summary: Schema.String,
}))

const prompt = (page: UiPage, request: string): string => `Grade this governed generated page against the original request from 1-5 on each axis:

- hierarchy: the recipe slots and block order form a clear, scannable visual narrative.
- informationArchitecture: navigation, section naming, grouping, and progressive disclosure match the user's task and mental model.
- specificity: copy and data are concrete and directly relevant to the request, not generic filler, template residue, or repeated claims.
- designSystem: block semantics are used consistently and intentionally; the page feels composed from one system rather than arbitrary widgets forced into slots.
- composition: the chosen block variety is coherent for its ${page.manifest.archetype} archetype; diagrams/tables/forms are used when appropriate.
- interaction: actions and forms are purposeful, minimal, and consistent with the page's goal; a document may score 5 with no actions when none are needed.

ORIGINAL REQUEST:
${request}

PAGE SPECIFICATION:
${JSON.stringify(page)}

End with exactly one JSON object:
{"hierarchy":n,"informationArchitecture":n,"specificity":n,"designSystem":n,"composition":n,"interaction":n,"summary":"one sentence"}`

export const makeUiPageQualityJudge = <W>(options: {
  readonly page: (world: W) => Effect.Effect<UiPage, unknown>
  readonly request: (world: W) => Effect.Effect<string, unknown>
  readonly call: (prompt: string) => Effect.Effect<string, unknown>
}): Judge<W> => ({
  name: "ui-page-quality",
  run: (world) => Effect.gen(function* () {
    const page = yield* options.page(world)
    const request = yield* options.request(world)
    const response = yield* options.call(prompt(page, request))
    const start = response.lastIndexOf('{"hierarchy"')
    const grades = yield* Schema.decodeUnknown(Grades)(start >= 0 ? response.slice(start).trim() : response.trim())
    const score = (grades.hierarchy + grades.informationArchitecture + grades.specificity + grades.designSystem + grades.composition + grades.interaction) / 30
    return { score, reason: `${grades.summary} — hierarchy ${grades.hierarchy}/5 · IA ${grades.informationArchitecture}/5 · specificity ${grades.specificity}/5 · design system ${grades.designSystem}/5 · composition ${grades.composition}/5 · interaction ${grades.interaction}/5` }
  }),
})
