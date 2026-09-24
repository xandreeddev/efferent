import type { JourneyExpectation, JourneyObservation, JourneyScore } from "./journey.entity.js"

export const scoreJourneyTurn = (expected: JourneyExpectation, observed: JourneyObservation, locale: string): JourneyScore => {
  const missing = (label: string, required: ReadonlyArray<string>, actual: ReadonlyArray<string>) => required.filter((value) => !actual.includes(value)).map((value) => `Missing ${label}: ${value}`)
  const failures = [
    ...(expected.maxAgentSteps === undefined || (observed.agentSteps !== undefined && observed.agentSteps <= expected.maxAgentSteps) ? [] : ["Agent step ceiling exceeded or unobserved"]),
    ...(expected.requiredToolArguments ?? []).filter((required) => !(observed.toolCalls ?? []).some((call) => call.name === required.name && Object.entries(required.arguments).every(([key, value]) => JSON.stringify(call.arguments[key]) === JSON.stringify(value)))).map((required) => `Missing tool arguments: ${required.name}`),
    ...missing("tool", expected.requiredTools, observed.tools),
    ...expected.forbiddenTools.filter((tool) => observed.tools.includes(tool)).map((tool) => `Forbidden tool: ${tool}`),
    ...missing("recipe", expected.recipes, observed.recipes),
    ...missing("component", expected.components, observed.components),
    ...(expected.forbiddenComponents ?? []).filter((component) => observed.components.includes(component)).map((component) => `Forbidden component: ${component}`),
    ...missing("link", expected.requiredLinks ?? [], observed.links ?? []),
    ...(expected.canvas === undefined || expected.canvas === observed.canvas ? [] : [`Expected canvas ${expected.canvas}, received ${observed.canvas}`]),
    ...(expected.layout === undefined || expected.layout === observed.layout ? [] : [`Expected layout ${expected.layout}, received ${observed.layout}`]),
    ...(expected.minAgentSteps === undefined || (observed.agentSteps !== undefined && observed.agentSteps >= expected.minAgentSteps) ? [] : ["Insufficient observed agent steps"]),
    ...(expected.maxNewRuns === undefined || (observed.newRuns !== undefined && observed.newRuns <= expected.maxNewRuns) ? [] : ["Unexpected new agent run"]),
    ...expected.requiredText.filter((text) => !observed.text.includes(text)).map((text) => `Missing text: ${text}`),
    ...expected.forbiddenText.filter((text) => observed.text.includes(text)).map((text) => `Forbidden text: ${text}`),
    ...(expected.outcome === observed.outcome ? [] : [`Expected outcome ${expected.outcome}, received ${observed.outcome}`]),
    ...(locale === observed.locale ? [] : [`Expected locale ${locale}, received ${observed.locale}`]),
    ...(observed.evidence.length > 0 ? [] : ["No observable journey evidence"]),
  ]
  return { passed: failures.length === 0, failures }
}

/** Set scores are diagnostic only: a forbidden capability always fails. */
export const scoreSelection = (expected: ReadonlyArray<string>, predicted: ReadonlyArray<string>, forbidden: ReadonlyArray<string> = []) => {
  const target = new Set(expected)
  const actual = new Set(predicted)
  const truePositive = [...actual].filter((value) => target.has(value)).length
  const precision = actual.size === 0 ? (target.size === 0 ? 1 : 0) : truePositive / actual.size
  const recall = target.size === 0 ? 1 : truePositive / target.size
  const f2 = precision + recall === 0 ? 0 : 5 * precision * recall / (4 * precision + recall)
  return { precision, recall, f2, forbidden: forbidden.filter((value) => actual.has(value)), exact: target.size === actual.size && truePositive === target.size }
}
