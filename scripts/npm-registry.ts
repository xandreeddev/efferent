/**
 * The registry reads behind `bun run publish:packages` and `bun run release:publish`. What an
 * answer means, and when to stop asking, are the pure functions in publish-plan.ts.
 */
import { Result } from "effect"
import { confirmSchedule, confirmation, label, registry, registryAnswer, registryProvenance } from "./publish-plan.js"
import type { Confirmation, Versioned } from "./publish-plan.js"

/** Whether the registry has `item`. Cache-busted, because the registry's CDN can keep serving a 404 for a version that was just published. */
export const onRegistry = (item: Versioned): Promise<Result.Result<boolean, string>> =>
  fetch(`${registry}/${item.name.replace("/", "%2f")}/${item.version}?cb=${Date.now()}`, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(30_000) }).then(
    (response) => registryAnswer(item, response.status),
    (error: unknown) => Result.fail(`the registry could not be reached for ${label(item)}: ${String(error)}`),
  )

/** Fail closed when an existing version cannot be tied to this release's exact commit; require presence when validating a skip. */
export const checkRegistryProvenance = (item: Versioned, head: string, requiredPresence = false): Promise<Result.Result<void, string>> =>
  fetch(`${registry}/${item.name.replace("/", "%2f")}/${item.version}?cb=${Date.now()}`, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(30_000) }).then(
    (response) => requiredPresence && response.status === 404
      ? Result.fail(`${label(item)} disappeared from the registry before its source commit could be verified; refusing to skip it`)
      : response.status === 200
      ? response.text().then((body) => registryProvenance(item, head, response.status, body))
      : registryProvenance(item, head, response.status, ""),
  ).then((verdict) => verdict, (error: unknown) => Result.fail(`the registry release metadata could not be read for ${label(item)}: ${String(error)}`))

/** A settled confirmation: the registry has the version, or it still does not after `confirmSchedule`. */
export type Settled = Exclude<Confirmation, { readonly _tag: "Pending" }>

/** Ask the registry for `item` now, then every `schedule.intervalMillis` until it has it or `schedule.attempts` answers say it does not (`confirmSchedule`: about three minutes). */
export const confirmOnRegistry = async (
  item: Versioned, answers: ReadonlyArray<Result.Result<boolean, string>> = [], schedule: { readonly attempts: number, readonly intervalMillis: number } = confirmSchedule,
): Promise<Settled> => {
  const verdict = confirmation(item, answers, schedule.attempts)
  if (verdict._tag !== "Pending") return verdict
  if (answers.length > 0) await Bun.sleep(schedule.intervalMillis)
  return confirmOnRegistry(item, [...answers, await onRegistry(item)], schedule)
}
