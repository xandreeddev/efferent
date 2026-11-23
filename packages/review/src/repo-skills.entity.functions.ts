import { Array as Arr, Order } from "effect"
import type { FileDiff } from "./diff.entity.js"
import { shownPath } from "./diff.entity.functions.js"
import { packDiff } from "./packed-diff.entity.functions.js"
import { NO_SKILLS, SECTIONS_NOTE, SKILL_HEADINGS_ROOM, SKILL_ROOM_LEAST, SKILLS_SHOWN, TERMS_LEFT_OUT } from "./repo-skills.entity.js"
import type { RepoSkill, ShownSkills, SkillRoute } from "./repo-skills.entity.js"
import { globMatches } from "./review-tools.entity.functions.js"

/** Whether a route calls for its skill: one of `paths` matches a glob of its, or `diff` holds one of its words. */
export const callsFor = (route: SkillRoute, paths: ReadonlyArray<string>, diff: string): boolean =>
  route.paths.some((glob) => paths.some((path) => globMatches(glob, path))) || route.diff.some((words) => diff.includes(words))

/** The skills a group's paths and diff call for (`callsFor`), in the order their routes are declared. */
export const routedSkills = (skills: ReadonlyArray<RepoSkill>, paths: ReadonlyArray<string>, diff: string): ReadonlyArray<RepoSkill> =>
  skills.filter((skill) => callsFor(skill.route, paths, diff))

/**
 * The words a group's paths rank a skill's sections by: each folder's name and each file's stem and roles (the parts
 * between its stem and its extension: `entity`, `functions` of `vote.entity.functions.ts`), lower case, those of
 * three characters or more and not in `TERMS_LEFT_OUT`.
 */
export const termsOf = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const kept = (word: string) => word.length > 2 && !TERMS_LEFT_OUT.includes(word)
  const words = paths.flatMap((path) => {
    const parts = path.split("/")
    const name = (parts.at(-1) ?? "").split(".")
    return [...parts.slice(0, -1), name[0] ?? "", ...name.slice(1, -1)].map((word) => word.toLowerCase())
  })
  return Arr.dedupe(words.filter(kept))
}

/**
 * A Markdown text's level-two sections: what comes before the first (`heading` empty), then each `## ` heading with its
 * body. A `## ` line inside a fenced block (between lines starting with three backticks or tildes) is the block's text.
 */
export const sectionsOf = (text: string): ReadonlyArray<{ readonly heading: string; readonly body: string }> => {
  const out: Array<{ heading: string; body: Array<string> }> = [{ heading: "", body: [] }]
  let fenced = false
  for (const line of text.split("\n")) {
    if (line.startsWith("```") || line.startsWith("~~~")) fenced = !fenced
    if (!fenced && line.startsWith("## ")) out.push({ heading: line, body: [] })
    else out[out.length - 1]?.body.push(line)
  }
  return out.map((section) => ({ heading: section.heading, body: section.body.join("\n") }))
}

/** A section as ranked: where it is in the skill, how many of the group's terms it holds, and its size. */
interface Ranked {
  readonly at: number
  readonly score: number
  readonly size: number
}

/**
 * A skill too long for the room left, by its sections: its title (the first `# ` line before them), every section's
 * heading, the sections the group's terms rank highest (most terms held, then in order) whole while they fit in
 * `room` less `SKILL_HEADINGS_ROOM`, and `SECTIONS_NOTE`; none when no section fits.
 */
const bySections = (path: string, text: string, terms: ReadonlyArray<string>, room: number): ReadonlyArray<string> => {
  const sections = sectionsOf(text)
  const score = (section: { readonly heading: string; readonly body: string }) => terms.filter((term) => `${section.heading}${section.body}`.toLowerCase().includes(term)).length
  const ranked = Arr.sort(
    sections.flatMap((section, at): ReadonlyArray<Ranked> => (section.heading.length > 0 ? [{ at, score: score(section), size: section.heading.length + section.body.length + 2 }] : [])),
    Order.combine(Order.mapInput(Order.flip(Order.Number), (one: Ranked) => one.score), Order.mapInput(Order.Number, (one: Ranked) => one.at)),
  )
  const kept = new Set<number>()
  let left = room - SKILL_HEADINGS_ROOM
  for (const one of ranked) {
    if (one.size <= left) {
      kept.add(one.at)
      left -= one.size
    }
  }
  if (kept.size === 0) return []
  const title = (sections[0]?.body ?? "").split("\n").filter((line) => line.startsWith("# ")).slice(0, 1)
  return [
    `File: ${shownPath(path)}`,
    ...title,
    ...sections.flatMap((section, at) => (section.heading.length === 0 ? [] : [kept.has(at) ? `${section.heading}\n${section.body.trim()}` : section.heading])),
    `${SECTIONS_NOTE}\n`,
  ]
}

/**
 * The skills a group's message shows, in their order, within `room` characters: each whole (`File: <path>` and its
 * text) while it fits in what is left, else by its sections (`bySections`); a skill whose text is empty, or that comes
 * when less than `SKILL_ROOM_LEAST` is left, is not shown, nor one whose block (by sections too: many headings) would
 * take the text shown past `room`, so the text shown never passes it.
 */
export const skillsShown = (skills: ReadonlyArray<RepoSkill>, paths: ReadonlyArray<string>, room: number = SKILLS_SHOWN): ShownSkills => {
  const terms = termsOf(paths)
  const parts: Array<string> = []
  const shown: Array<string> = []
  let left = room
  let used = 0 // the length of `parts.join("\n")`
  for (const skill of skills) {
    const text = skill.text.trim()
    if (text.length === 0 || left < SKILL_ROOM_LEAST) continue
    const joint = parts.length > 0 ? 1 : 0
    const wholeBlock = `File: ${shownPath(skill.route.path)}\n${text}\n`
    const whole = text.length <= left && used + joint + wholeBlock.length <= room
    const block = whole ? wholeBlock : bySections(skill.route.path, text, terms, left).join("\n")
    const after = used + joint + block.length
    if (block.length === 0 || after > room) continue
    parts.push(block)
    shown.push(skill.route.path)
    used = after
    left -= whole ? text.length : block.length
  }
  return { paths: shown, text: parts.join("\n") }
}

/**
 * The skills a focused turn's group shows (`skillsShown`): those its files' paths and its packed diff (as the group's
 * message shows it, under `budgetTokens`) call for (`routedSkills`).
 */
export const groupSkills = (skills: ReadonlyArray<RepoSkill>, group: ReadonlyArray<FileDiff>, budgetTokens: number): ShownSkills => {
  if (skills.length === 0) return NO_SKILLS
  const paths = group.map((file) => file.path)
  return skillsShown(routedSkills(skills, paths, packDiff(group, budgetTokens).text), paths)
}
