const defineEval = <T>(spec: T): T => spec

export const suite = defineEval({
  name: "unregistered",
  scorers: [{ name: "coverage" }],
  threshold: 0.7,
})
