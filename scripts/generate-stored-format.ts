import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { STORED_FORMAT } from "@xandreed/core"
import { fingerprintOf, formatProblems, nextRecord, storedShapes, StoredFormatRecord } from "./stored-format.js"

/*
 * Writes `docs/stored-format.json`: the fingerprint of every shape the
 * framework stores in a session log, at `STORED_FORMAT`, and the history of
 * every format's fingerprint. Run by `bun run docs:generate`. It fails, and
 * writes nothing, when a stored shape changed without a bump of
 * `STORED_FORMAT`, when a bump changed nothing, or when the history does not
 * run 1, 2, 3…; CI then fails on the unchanged file as well.
 */

const target = join(import.meta.dir, "../docs/stored-format.json")
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredFormatRecord))

const recorded = existsSync(target) ? Option.some(await Effect.runPromise(decodeRecord(await readFile(target, "utf8")))) : Option.none()
const { shapes, problems: missing } = storedShapes()
const current = fingerprintOf(shapes)
const problems = [...missing, ...formatProblems(recorded, current, STORED_FORMAT)]

if (problems.length > 0) {
  console.error(problems.join("\n"))
  process.exit(1)
}

await writeFile(target, `${JSON.stringify(nextRecord(recorded, current, STORED_FORMAT), null, 2)}\n`)
console.log(`Wrote docs/stored-format.json: stored format ${STORED_FORMAT}, ${shapes.length} shapes`)
