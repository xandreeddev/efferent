/**
 * A `Skill` is a markdown file with YAML-ish frontmatter (`name`,
 * `description`) and a free-form body. The name + description are
 * injected into the coder system prompt so the model knows the skill
 * exists; the body is lazy-loaded via the `read_skill` tool only when
 * the model decides it needs the details. Pi pattern.
 *
 * Discovery walks `.efferent/skills/*.md` from cwd up to home; closer-to-cwd
 * wins on name collisions.
 */
export interface Skill {
  readonly name: string
  readonly description: string
  /** Absolute path to the source `.md` — read lazily by `read_skill`. */
  readonly sourcePath: string
}
