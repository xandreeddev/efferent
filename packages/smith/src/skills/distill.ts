import { join } from "node:path"
import { Effect } from "effect"
import { FileSystem } from "@xandreed/engine"
import { MemoryTopic } from "../memory/domain.js"
import type { MemoryRecord } from "../memory/domain.js"
import { SKILLS_DIR } from "./skills.js"

/**
 * The loop authors its OWN skills. A workspace memory that independent runs
 * keep re-confirming is no longer a "verify before relying" fact — it is a
 * procedure worth following. Past this corroboration bar, the curator
 * distills each topic's confirmed memories into a `learned-<topic>.md` skill
 * (machine-owned, rewritten every run), so tier-1 discovery surfaces it by
 * name and the coder can `load_skill` the full checklist.
 *
 * DETERMINISTIC — no LLM: the ledger already did the extraction/consolidation;
 * this is a pure projection of the corroboration counts onto files. Because
 * corroboration only climbs (or an `invalidate` drops the record whole), a
 * topic that falls back below the bar has its file REMOVED, so a retracted
 * fact never keeps surfacing as a skill.
 */

/** Three independent runs must have confirmed a fact before it graduates to a
 *  skill (create = 1, each corroborate = +1). */
export const SKILL_DISTILL_MIN_CORROBORATION = 3
const DESCRIPTION_CAP_CHARS = 200

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`

/** The `learned-<topic>` skill's name — the file stem, distinct from any the
 *  human hand-authors. */
export const distilledSkillName = (topic: MemoryTopic): string => `learned-${topic}`

/** The skill file body — frontmatter (name/description) + a machine-owned
 *  header + the confirmed statements as a checklist, most-confirmed first. */
export const renderDistilledSkill = (
  topic: MemoryTopic,
  records: ReadonlyArray<MemoryRecord>,
): string => {
  const description = clip(
    `${records.length} ${topic} fact${records.length === 1 ? "" : "s"} this workspace has confirmed across ≥${SKILL_DISTILL_MIN_CORROBORATION} sessions — read before writing ${topic}-sensitive code.`,
    DESCRIPTION_CAP_CHARS,
  )
  const lines = records.map(
    (record) => `- ${record.statement} (confirmed ×${record.corroboration})`,
  )
  return [
    "---",
    `name: ${distilledSkillName(topic)}`,
    `description: ${description}`,
    "---",
    "<!-- AUTO-DISTILLED from .efferent/memory/ledger.jsonl — rewritten every run. Curate the ledger, not this file. -->",
    "",
    `# Confirmed ${topic}s`,
    ...lines,
    "",
  ].join("\n")
}

/**
 * Project the active memory set onto `learned-<topic>.md` skill files: write
 * (or refresh) one per topic that clears the bar, remove one whose topic no
 * longer does. Best-effort throughout — a write or remove that fails is
 * skipped, never fatal. Returns the names of skills currently present.
 */
export const distillSkillsFromMemory = (options: {
  readonly cwd: string
  readonly actives: ReadonlyArray<MemoryRecord>
}): Effect.Effect<ReadonlyArray<string>, never, FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const dir = join(options.cwd, SKILLS_DIR)
    const perTopic = (topic: MemoryTopic): Effect.Effect<ReadonlyArray<string>, never, FileSystem> => {
      const qualifying = options.actives
        .filter(
          (record) =>
            record.topic === topic && record.corroboration >= SKILL_DISTILL_MIN_CORROBORATION,
        )
        .sort((a, b) => b.corroboration - a.corroboration)
      const path = join(dir, `${distilledSkillName(topic)}.md`)
      return qualifying.length === 0
        ? fs.remove(path).pipe(Effect.ignore, Effect.as([] as ReadonlyArray<string>))
        : fs.mkdir(dir).pipe(
            Effect.zipRight(fs.write(path, renderDistilledSkill(topic, qualifying))),
            Effect.as([distilledSkillName(topic)] as ReadonlyArray<string>),
            Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
          )
    }
    const written = yield* Effect.forEach(MemoryTopic.literals, perTopic)
    return written.flat()
  })
