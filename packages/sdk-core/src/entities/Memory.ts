/**
 * A `Memory` is a durable, agent-maintained knowledge record: a markdown file
 * with optional YAML-ish frontmatter (`title`, `summary`) and a free-form body.
 * It captures the *why* an engineer accumulates — architecture decisions,
 * conventions, gotchas — so an agent can read code fresh yet keep the distilled
 * rationale. The title + summary are injected into the system prompt as a curated
 * INDEX (not a giant stale context); the body is lazy-loaded via the
 * `read_memory` tool only when the model decides it's relevant, and new records
 * are written with the `remember` tool. Mirrors the {@link Skill} mechanism.
 *
 * Discovery walks `.efferent/memory/*.md` from cwd up to home; closer-to-cwd
 * wins on name collisions.
 */
export interface Memory {
  /** Slug derived from the filename (sans `.md`) — the lazy-load key. */
  readonly name: string
  /** Human-readable index title (`title` frontmatter, else the slug). */
  readonly title: string
  /** One-line index summary (`summary` frontmatter, else empty). */
  readonly summary: string
  /** Absolute path to the source `.md` — read lazily by `read_memory`. */
  readonly sourcePath: string
}
