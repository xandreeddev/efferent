const defineEval = <T>(spec: T): T => spec

export const suite = defineEval({ name: "no-threshold", scorers: [{ name: "coverage" }] })
