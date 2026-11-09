/**
 * The registry reads behind `bun run publish:packages` and `bun run release:publish`. What an
 * answer means, and when to stop asking, are the pure functions in publish-plan.ts.
 */
import { Result } from "effect"
import { confirmSchedule, label, registry, registryAnswer, releaseProvenance } from "./publish-plan.js"
import type { Confirmation, Provenance, Versioned } from "./publish-plan.js"

/** Read release metadata within a byte limit; always cancel the transport body. */
const metadataBody = async (response: Response): Promise<string> => {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return new TextDecoder().decode(Buffer.concat(chunks))
      size += chunk.value.byteLength
      if (size > 4 * 1024 * 1024) throw new Error("registry metadata exceeds 4 MiB")
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
}
const request = (item: Versioned, timeoutMs: number) => fetch(`${registry}/${item.name.replace("/", "%2f")}/${item.version}?cb=${Date.now()}`, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))) })

/** Whether the registry has the version. Unread bodies are always cancelled. */
export const onRegistry = async (item: Versioned, timeoutMs = 30_000): Promise<Result.Result<boolean, string>> => {
  try {
    const response = await request(item, timeoutMs)
    try { return registryAnswer(item, response.status) } finally { await response.body?.cancel() }
  } catch { return Result.fail(`the registry could not be reached for ${label(item)}`) }
}

/** One provenance read: only metadata the registry answered can refuse; every other failure is unanswered. */
const readProvenance = async (item: Versioned, head: string, requiredPresence: boolean, timeoutMs: number): Promise<Provenance> => {
  try {
    const response = await request(item, timeoutMs)
    if (response.status === 200) return releaseProvenance(item, head, await metadataBody(response))
    await response.body?.cancel()
    if (requiredPresence && response.status === 404) return { _tag: "Unanswered", reason: `${label(item)} disappeared from the registry before its source commit could be verified` }
    const answer = registryAnswer(item, response.status)
    return Result.isFailure(answer) ? { _tag: "Unanswered", reason: answer.failure } : { _tag: "Verified" }
  } catch { return { _tag: "Unanswered", reason: `the registry release metadata could not be read for ${label(item)}` } }
}

/** Fail closed unless release metadata names the exact expected source commit. */
export const checkRegistryProvenance = async (item: Versioned, head: string, requiredPresence = false, timeoutMs = 30_000): Promise<Result.Result<void, string>> => {
  const provenance = await readProvenance(item, head, requiredPresence, timeoutMs)
  return provenance._tag === "Verified" ? Result.succeed(undefined) : Result.fail(provenance.reason)
}

export type Settled = Exclude<Confirmation, { readonly _tag: "Pending" }>

/**
 * Confirmation has a wall deadline, including every HTTP request and wait. Presence alone never
 * confirms an upload: metadata that names another commit (or none) is missing at once, and a
 * provenance read the registry did not answer is asked again, as presence is, until the deadline.
 */
export const confirmOnRegistry = async (
  item: Versioned, head: string, schedule: { readonly attempts: number; readonly intervalMillis: number } = confirmSchedule,
): Promise<Settled> => {
  const deadline = Date.now() + schedule.attempts * schedule.intervalMillis
  let reason = `the registry did not confirm ${label(item)} before its deadline`
  for (let attempt = 0; attempt < schedule.attempts && Date.now() < deadline; attempt++) {
    const found = await onRegistry(item, Math.min(30_000, deadline - Date.now()))
    if (Result.isSuccess(found) && found.success) {
      if (Date.now() >= deadline) return { _tag: "Missing", reason }
      const provenance = await readProvenance(item, head, true, Math.min(30_000, deadline - Date.now()))
      if (provenance._tag === "Verified") return { _tag: "Published" }
      if (provenance._tag === "Refused") return { _tag: "Missing", reason: provenance.reason }
      reason = provenance.reason
    } else if (Result.isFailure(found)) reason = found.failure
    const remaining = deadline - Date.now()
    if (attempt + 1 < schedule.attempts && remaining > 0) await Bun.sleep(Math.min(schedule.intervalMillis, remaining))
  }
  return { _tag: "Missing", reason }
}
