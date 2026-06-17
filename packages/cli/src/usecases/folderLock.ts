import { Effect, Ref } from "effect"

/**
 * Per-folder serialization for parallel sub-agent fan-out. Folder sandboxing
 * makes *disjoint* folders safe to run concurrently (writes can't collide by
 * construction); two spawns into the **same** folder, though, would race on
 * the same files — so each folder gets a 1-permit semaphore and same-folder
 * spawns queue while everything else fans out.
 *
 * One locks map per `ScopeRuntime` (created at the composition root and
 * threaded down through nested spawns), so cousins in different subtrees
 * still contend on the same folder key. Keys are exact resolved paths —
 * ancestor/descendant overlap (a spawn into `pkg/` racing one into
 * `pkg/sub/`) is deliberately not locked: detecting it means holding multiple
 * locks, which buys a deadlock risk for a case the prompt already steers away
 * from (spawn in dependency order).
 */
export type FolderLocks = Ref.Ref<ReadonlyMap<string, Effect.Semaphore>>

export const makeFolderLocks = (): FolderLocks =>
  Ref.unsafeMake<ReadonlyMap<string, Effect.Semaphore>>(new Map())

/** Get-or-create the folder's semaphore atomically (unsafeMake is pure). */
const lockFor = (
  locks: FolderLocks,
  folder: string,
): Effect.Effect<Effect.Semaphore> =>
  Ref.modify(locks, (m) => {
    const existing = m.get(folder)
    if (existing !== undefined) return [existing, m] as const
    const sem = Effect.unsafeMakeSemaphore(1)
    const next = new Map(m)
    next.set(folder, sem)
    return [sem, next] as const
  })

/** Run `effect` holding the folder's exclusive permit. */
export const withFolderLock =
  (locks: FolderLocks, folder: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(lockFor(locks, folder), (sem) => sem.withPermits(1)(effect))
