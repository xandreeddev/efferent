import type { RunRef } from "./run.entity.js"

/** `<turn>.<ordinal>`: what the ids a run mints start with. Turn numbers are unique across a session's visible history, forks included. */
const runPrefixOf = (run: RunRef): string => `${run.turn}.${run.ordinal}`

/**
 * The id minted for a provider's id-less tool call of `tool`, the `n`th
 * call (from 0) of `step` in the run `run`: `<turn>.<ordinal>.<step>:<tool>:<n>`.
 * Distinct across the steps and runs of a turn and the turns of a session.
 */
export const toolCallIdOf = (run: RunRef, step: number, tool: string, n: number): string => `${runPrefixOf(run)}.${step}:${tool}:${n}`

/** The id of the `n`th call (from 0) of a run's host-planned batch: `<turn>.<ordinal>.planned:<n>`. */
export const plannedCallIdOf = (run: RunRef, n: number): string => `${runPrefixOf(run)}.planned:${n}`
