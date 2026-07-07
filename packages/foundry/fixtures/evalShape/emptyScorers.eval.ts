const defineEval = <T>(spec: T): T => spec

export const suite = defineEval({ name: "empty-scorers", scorers: [], threshold: 0.8 })
