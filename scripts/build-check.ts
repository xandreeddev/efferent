/**
 * What a package build ships and when `bun run verify:packages` trusts a build, as pure
 * functions: scripts/build-packages.ts leaves out what `isTestCode` names, and
 * scripts/verify-packages.ts refuses a build `verifyRefusals` objects to.
 * build-check.test.ts covers them.
 */
import { notClean, notOfHead } from "./publish-plan.js"
import type { BuildStamp, Ran } from "./publish-plan.js"

/**
 * Whether a file of a package (a path relative to the package, its `src` or its `dist`, with
 * `/` separators) is test code, which the build leaves out: a `*.test.*` or `*.bench.*`
 * file, a `testing` module (`testing.ts`, `<name>.testing.ts`, or `testing.port.ts` for a
 * test-only service), anything in a `testing/` folder, and the declarations of each.
 */
export const isTestCode = (file: string): boolean => {
  const segments = file.split("/")
  const name = (segments.at(-1) ?? "").replace(/\.d\.ts$/, ".ts")
  return segments.includes("testing") || /\.(test|bench)\.[^.]+$/.test(name) || /^(.+\.)?testing(\.port)?\.[^.]+$/.test(name)
}

/** What verify-packages.ts read before checking the packed packages. */
export interface VerifyState {
  readonly stamp: BuildStamp
  /** `git rev-parse HEAD` */
  readonly head: Ran
  /** The built files `isTestCode` names, relative to `.artifacts/packages`. */
  readonly testCode: ReadonlyArray<string>
  /** `--allow-dirty`: a build of uncommitted changes, for checking them before a commit. */
  readonly allowDirty: boolean
}

/**
 * Every reason the built packages are not the ones to check (empty when they are): a build
 * from another commit than `HEAD` (stale artifacts), one from a tree with changes unless
 * `allowDirty`, and test code in a built package.
 */
export const verifyRefusals = ({ stamp, head, testCode, allowDirty }: VerifyState): ReadonlyArray<string> => [
  ...notOfHead(stamp, head),
  ...(allowDirty ? [] : notClean(stamp).map((reason) => `${reason}, or pass --allow-dirty to check a build of uncommitted changes`)),
  ...(testCode.length === 0 ? [] : [`the built packages hold test code: ${testCode.slice(0, 10).join(", ")}${testCode.length > 10 ? `, and ${testCode.length - 10} more` : ""}; rebuild`]),
]
