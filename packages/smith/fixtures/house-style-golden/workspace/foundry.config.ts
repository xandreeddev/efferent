// The ARMED house-style profile — the live battery's oracle.
import { rules } from "./.efferent/gates/index.js"

export const customRules = rules

export default {
  tsconfig: "tsconfig.json",
  rules: [
    { rule: "effect/no-try-catch", include: ["src/**/*.ts"] },
    { rule: "effect/no-let", include: ["src/**/*.ts"] },
    { rule: "effect/no-loop-statements", include: ["src/**/*.ts"] },
    { rule: "effect/no-nullable-return", include: ["src/**/*.ts"] },
    { rule: "effect/match-over-tag-switch", include: ["src/**/*.ts"] },
    { rule: "effect/no-as-any", include: ["src/**/*.ts"] }
  ],
  typecheck: true
}
