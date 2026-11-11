// The Step 6 controls edit the learner's config text in place, so the code and
// the controls never disagree. A field the learner rewrote beyond recognition
// is left alone (the setter reports false) rather than guessed at.

const patterns = {
  system: /(system:\s*)("(?:[^"\\\n]|\\.)*")/,
  maxSteps: /(maxSteps:\s*)(\d+)/,
  streaming: /(streaming:\s*)(true|false)/,
  budgetTokens: /(budgetTokens:\s*)(\d[\d_]*)/,
} as const

export type ControlKey = keyof typeof patterns

const literal = (key: ControlKey, value: string | number | boolean): string =>
  key === "system" ? JSON.stringify(value) : String(value)

/** The new source, or undefined when the field cannot be found in it. */
export const setField = (source: string, key: ControlKey, value: string | number | boolean): string | undefined =>
  patterns[key].test(source) ? source.replace(patterns[key], (_all, head: string) => `${head}${literal(key, value)}`) : undefined

export interface Controls {
  readonly system?: string
  readonly maxSteps?: number
  readonly streaming?: boolean
  readonly budgetTokens?: number
}

export const readControls = (source: string): Controls => {
  const system = patterns.system.exec(source)?.[2]
  const maxSteps = patterns.maxSteps.exec(source)?.[2]
  const streaming = patterns.streaming.exec(source)?.[2]
  const budget = patterns.budgetTokens.exec(source)?.[2]
  const parsedSystem = system === undefined ? undefined : (() => { try { return JSON.parse(system) as unknown } catch { return undefined } })()
  return {
    ...(typeof parsedSystem === "string" ? { system: parsedSystem } : {}),
    ...(maxSteps === undefined ? {} : { maxSteps: Number(maxSteps) }),
    ...(streaming === undefined ? {} : { streaming: streaming === "true" }),
    ...(budget === undefined ? {} : { budgetTokens: Number(budget.replaceAll("_", "")) }),
  }
}
