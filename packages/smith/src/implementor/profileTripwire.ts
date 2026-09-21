import { join } from "node:path"
import { Effect, Equal, Option } from "effect"
import { FileSystem } from "@xandreed/core"

/**
 * THE ARMED-PROFILE TRIPWIRE (#111): the coding handlers refuse to write the
 * gate profile, but the 2026-07-12 incident was a Bash cleanup command — so
 * the profile is ALSO fingerprinted when a coder session starts and checked
 * after every turn. Any drift (edit, deletion, creation) is reported loudly:
 * the judged must not edit the judge. Shared by the forge implementor and
 * the post-run follow-up so the two coder paths guard the same files.
 */

/** Which armed-profile files drifted between two content snapshots (`None`
 * = absent): an edit, a deletion, and a creation all count — the judged
 * must not edit the judge in ANY direction (#111). */
export const profileDrift = (
  paths: ReadonlyArray<string>,
  before: ReadonlyArray<Option.Option<string>>,
  after: ReadonlyArray<Option.Option<string>>,
): ReadonlyArray<string> => paths.filter((_, index) => !Equal.equals(before[index], after[index]))

export interface ProfileTripwire {
  /** `<cwd>/foundry.config.ts` (by convention) plus every explicitly armed path. */
  readonly paths: ReadonlyArray<string>
  /** Re-read the profile and name every file that changed since arming. */
  readonly check: Effect.Effect<ReadonlyArray<string>>
}

export const armProfileTripwire = (
  cwd: string,
  protectedPaths: ReadonlyArray<string>,
): Effect.Effect<ProfileTripwire, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const paths: ReadonlyArray<string> = [join(cwd, "foundry.config.ts"), ...protectedPaths]
    const snapshot = Effect.forEach(paths, (path) => fs.read(path).pipe(Effect.option))
    const armed = yield* snapshot
    return {
      paths,
      check: snapshot.pipe(Effect.map((now) => profileDrift(paths, armed, now))),
    }
  })
