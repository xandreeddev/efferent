import { Effect, Option } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fingerprint } from "../domain/baseline.js"
import type { Finding } from "../domain/Finding.js"
import type { Gate } from "../ports/Gate.js"

/**
 * The ratchet IN the pipeline: findings whose fingerprint (rule + file +
 * normalized line CONTENT) sits in the committed baseline are dropped
 * BEFORE the verdict — only NEW findings gate a forge run. This is what
 * makes arming a profile on a legacy codebase survivable: existing
 * violations are grandfathered at `:lock`; the coder is judged on what it
 * writes, not on history. Touching a grandfathered line makes it fresh —
 * the intended "touch it, fix it" semantics.
 *
 * Only ERROR findings enter the ratchet (nothing else gates); an unreadable
 * source line fingerprints on rule+file+"" — almost surely not in the
 * baseline, so the finding stays. Fail-open toward STRICTNESS.
 */

const sourceLineOf = (
  rootDir: string,
  finding: Finding,
): Effect.Effect<Option.Option<string>> =>
  Option.match(finding.location, {
    onNone: () => Effect.succeed(Option.none<string>()),
    onSome: (location) =>
      Effect.tryPromise({
        try: () => fs.readFile(path.join(rootDir, location.file), "utf8"),
        catch: () => "unreadable" as const,
      }).pipe(
        Effect.map((text) => Option.fromNullable(text.split("\n")[location.line - 1])),
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
  })

export const withBaselineRatchet = <R>(
  gate: Gate<R>,
  baseline: ReadonlySet<string>,
): Gate<R> => ({
  ...gate,
  run: (workspace) =>
    gate.run(workspace).pipe(
      Effect.flatMap((findings) =>
        Effect.forEach(findings, (finding) =>
          finding.severity !== "error"
            ? Effect.succeed<ReadonlyArray<Finding>>([finding])
            : sourceLineOf(workspace.rootDir, finding).pipe(
                Effect.map(
                  (line): ReadonlyArray<Finding> =>
                    baseline.has(fingerprint(finding, line)) ? [] : [finding],
                ),
              ),
        ).pipe(Effect.map((kept) => kept.flat())),
      ),
    ),
})
