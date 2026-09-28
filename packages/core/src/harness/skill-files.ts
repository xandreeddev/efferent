import { Effect, Option, Schema } from "effect"
import { parseFrontmatter } from "../spec/frontmatter.js"
import type { Frontmatter } from "../spec/frontmatter.js"
import { SkillDefinition } from "./contribution.entity.js"
import { HarnessError } from "./plugin.entity.js"

/** One file of a skills tree, as the host read it. */
export interface SkillFile {
  /** Relative path, `/`-separated: `<skill>/SKILL.md` or `<skill>/references/<id>.md`. */
  readonly path: string
  readonly text: string
}

const invalid = (path: string, message: string) => new HarnessError({ code: "skills.files", message: `${path}: ${message}` })
const list = (value: string | undefined): ReadonlyArray<string> =>
  (value ?? "").split(",").map((item) => item.trim()).filter((item) => item.length > 0)
const headingOf = (body: string): Option.Option<string> =>
  Option.fromNullable(body.split("\n").find((line) => line.startsWith("# "))).pipe(Option.map((line) => line.slice(2).trim()))

/**
 * Skills from markdown files. `<skill>/SKILL.md` carries flat frontmatter —
 * `summary` (required), `id` (defaults to the directory), `version`,
 * `tools` and `permissions` (comma-separated), `always` (`true`) — and its
 * body is the load_skill instructions. Each `<skill>/references/<id>.md` is
 * one reference, titled by its `title` field or first heading.
 */
export const skillsFromFiles = (files: ReadonlyArray<SkillFile>): Effect.Effect<ReadonlyArray<SkillDefinition>, HarnessError> =>
  Effect.forEach(files.filter((file) => /^[^/]+\/SKILL\.md$/.test(file.path)), (file) => Effect.gen(function* () {
    const directory = file.path.split("/")[0] ?? ""
    const parsed = yield* Option.match(parseFrontmatter(file.text), {
      onNone: () => Effect.fail(invalid(file.path, "missing frontmatter")),
      onSome: Effect.succeed,
    })
    const references = yield* Effect.forEach(
      files.filter((candidate) => candidate.path.startsWith(`${directory}/references/`) && candidate.path.endsWith(".md")),
      (reference) => {
        const id = reference.path.slice(`${directory}/references/`.length, -".md".length)
        const document = Option.getOrElse(parseFrontmatter(reference.text), (): Frontmatter => ({ fields: {}, body: reference.text }))
        const title = Option.getOrElse(Option.orElse(Option.fromNullable(document.fields["title"]), () => headingOf(document.body)), () => id)
        return Effect.succeed({ id, title, text: document.body.trim() })
      },
    )
    const fields = parsed.fields
    return yield* Schema.decodeUnknown(SkillDefinition)({
      id: fields["id"] ?? directory,
      version: fields["version"] ?? "1",
      summary: fields["summary"] ?? "",
      instructions: parsed.body.trim(),
      tools: list(fields["tools"]),
      always: fields["always"] === "true",
      permissions: list(fields["permissions"]),
      references,
    }).pipe(Effect.mapError((error) => invalid(file.path, error.message)))
  }))
