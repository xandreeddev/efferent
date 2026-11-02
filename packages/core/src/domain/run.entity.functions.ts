import type { RunRef } from "./run.entity.js"

/**
 * `call_<turn>_<ordinal>`: what the ids a run mints start with. Turn numbers are unique across a
 * session's visible history, forks included. Minted ids hold only letters, digits and `_`, and stay
 * short (under 40 characters for any realistic turn, run, step and call count): every provider's
 * pairing key accepts them, so a session can switch providers with them in its history.
 */
const runPrefixOf = (run: RunRef): string => `call_${run.turn}_${run.ordinal}`

/**
 * The id minted for a provider's id-less tool call, the `n`th call (from 0)
 * of `step` in the run `run`: `call_<turn>_<ordinal>_<step>_<n>`. Distinct
 * across the steps and runs of a turn and the turns of a session.
 *
 * @public
 */
export const toolCallIdOf = (run: RunRef, step: number, n: number): string => `${runPrefixOf(run)}_${step}_${n}`

/** The id of the `n`th call (from 0) of a run's host-planned batch: `call_<turn>_<ordinal>_p<n>`. */
export const plannedCallIdOf = (run: RunRef, n: number): string => `${runPrefixOf(run)}_p${n}`
