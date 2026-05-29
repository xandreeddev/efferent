/**
 * A `Skill` is a markdown file with YAML-ish frontmatter (`name`,
 * `description`) and a free-form body. The name + description are
 * injected into the coder system prompt so the model knows the skill
 * exists; the body is lazy-loaded via the `read_skill` tool only when
 * the model decides it needs the details. Pi pattern.
 *
 * Skills come from two places: **internal** ones bundled with the agent
 * (base capabilities like web search — shipped in the binary's `skills/`
 * dir) and **external** ones discovered by walking `.agent/skills/*.md`
 * from cwd up to home. External shadows internal on a name collision, so a
 * workspace can override a built-in skill. A skill body may reference its
 * own directory via the `{{SKILL_DIR}}` token (substituted by `read_skill`)
 * — used by script-backed skills to locate their sidecar executable.
 */
export interface Skill {
  readonly name: string
  readonly description: string
  /** Absolute path to the source `.md` — read lazily by `read_skill`. */
  readonly sourcePath: string
  /** True for skills bundled with the agent; false for workspace/user skills. */
  readonly internal: boolean
}
