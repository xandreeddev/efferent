import { Effect } from "effect"
import { AssessmentError } from "./assessment.entity.js"
import type { Journey } from "./journey.entity.js"
import type { JourneySelection } from "./journey-selection.entity.js"

export const journeyTier = (journey: Journey): number => typeof journey.tier === "number" ? journey.tier : ({ blocking: 0, quality: 1, exploratory: 2 })[journey.tier]
export const journeyCoverage = (journey: Journey) => ({
  tools: [...new Set([...(journey.coverage?.tools ?? []), ...journey.turns.flatMap((turn) => turn.expected.requiredTools)])],
  forbiddenTools: [...new Set(journey.turns.flatMap((turn) => turn.expected.forbiddenTools))],
  recipes: [...new Set([...(journey.coverage?.recipes ?? []), ...journey.turns.flatMap((turn) => turn.expected.recipes)])],
})
export const selectJourneys = (journeys: ReadonlyArray<Journey>, selection: JourneySelection) => Effect.gen(function* () {
  const known = journeys.map(journeyCoverage)
  const unknown = selection.ids.some((id) => !journeys.some((journey) => journey.id === id)) ||
    selection.tools.some((tool) => !known.some((entry) => entry.tools.includes(tool) || entry.forbiddenTools.includes(tool))) ||
    selection.recipes.some((recipe) => !known.some((entry) => entry.recipes.includes(recipe))) ||
    selection.tiers.some((tier) => !Number.isInteger(tier) || tier < 0 || tier > 3)
  if (unknown) return yield* Effect.fail(new AssessmentError({ code: "invalid", message: "Unknown journey selector" }))
  const selected = journeys.filter((journey) => {
    const coverage = journeyCoverage(journey)
    return (!selection.tiers.length || selection.tiers.includes(journeyTier(journey))) &&
      (!selection.ids.length || selection.ids.includes(journey.id)) &&
      (!selection.tools.length || selection.tools.some((tool) => coverage.tools.includes(tool) || coverage.forbiddenTools.includes(tool))) &&
      (!selection.recipes.length || selection.recipes.some((recipe) => coverage.recipes.includes(recipe)))
  })
  if (!selected.length) return yield* Effect.fail(new AssessmentError({ code: "invalid", message: "No matching journeys" }))
  return selected
})
