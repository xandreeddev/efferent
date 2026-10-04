import type { VerificationCheck } from "@xandreed/smith"

/** Planning shares the Gateway credential when either coding role uses Vercel. */
export const smithTrialPlanningOptions = (driverModel: string, editorModel: string) => driverModel.startsWith("vercel:") || editorModel.startsWith("vercel:")
  ? { protocol: "gateway" as const, model: "typesafe-ai/jev", endpoint: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model", apiKeyEnv: "AI_GATEWAY_API_KEY", apiKeyProvider: "vercel", timeoutMs: 10_000 }
  : { protocol: "systemone" as const, model: "jev-1.13", endpoint: "https://opencode.ai/zen/v1/systemone", apiKeyEnv: "OPENCODE_API_KEY", apiKeyProvider: "opencode", timeoutMs: 10_000 }

/** Credit direct successful check invocations, never command names printed as text. */
export const productionVerified = (checks: ReadonlyArray<VerificationCheck>): boolean => {
  const commands = checks.filter((check) => check.exitCode === 0).flatMap((check) => {
    const clauses = check.command.split(/&&|;|\n/).map((clause) => clause.trim()).filter(Boolean)
    return clauses.every((clause) => /^bun\s+(?:test|run\s+check)(?:\s+[A-Za-z0-9_./:=+-]+)*$/.test(clause)) ? clauses : []
  })
  return commands.some((command) => /^bun\s+test(?:\s|$)/.test(command)) && commands.some((command) => /^bun\s+run\s+check(?:\s|$)/.test(command))
}
