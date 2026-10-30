---
name: write-model-text
description: Rules and checklist for any text the model reads in efferent — tool and parameter descriptions, prompt sections, skill summaries and instructions, Failure messages, result views, host notes, correctives, summary and digest prompts. Covers where text lands, voice, framing untrusted text with core's hostNote/framed/escapeFrame/clipTo, tiers and versions, and pinning with exact tests and the golden. Read before adding or changing such text, and whenever the sdk golden fails.
---

# Write text the model reads

Model-facing text is a contract: changing it changes hosts' prompts and their
cached prefixes. Treat a wording change like an API change.

## 1. Know where it lands

| Text | Defined | Reaches the model as |
|---|---|---|
| Tool `description`, parameter `.annotate({ description })` | `Tool.make` in the capability's `*.adapter.ts`, or a pure `toolDescriptions(config)` in `*.entity.functions.ts` when it embeds config | the tool schema, on every step the tool is active |
| `PromptSection` (`id`, `version`, `tier`, `order`, `render`) | a capability's sections; `definePromptSection` with `requires` for one whose `render` reads services | system prompt: host `system`, then `static`, then `session` sections, each by `order` then `id` (`orderSections`, `core/src/turn/prompt-sections.ts`); `turn` sections become per-turn user messages |
| Skill `summary` | `defineSkill` | one catalogue line, loadable skills only |
| Skill `instructions` | `defineSkill` or a SKILL.md body | only through `load_skill` or a matcher seed; never for an `always: true` skill (tool discovery activates it but shows no instructions; `skillsDirectoryPlugin`'s `workspace.skills.always` section is the one exception) |
| `Failure { error, message }` | a handler failure with `failureMode: "return"` | the tool result |
| Result views and compact forms | beside the descriptions (`plugin-workspace/src/workspace-tools.entity.functions.ts`) | tool results; the compact form in older turns |
| Correctives, host notes, compaction handoffs | `plugin-agent-loop/src/loop.ts`, `core/src/memory/*`, `core/src/internal/mapping.entity.functions.ts` | user-role messages |
| Utility prompts | `summaryPrompt` (plugin-memory-summary), `digestPrompt` (plugin-memory-digest) | a `UtilityLlm` completion |

## 2. Write it

- Second person, imperative, plain. A tool description says, in order: what
  the tool does, what it returns, its limits (interpolated from config, never
  restated by hand), and when to use another tool instead.
- Name only what the model can see in the same request: tools this
  capability registers and headings its own sections render. Never point at
  a listing a host may or may not render (`core/src/mcp/bridge.ts` points at
  "External MCP tools"). Suggest `bash` only when the bash tool is enabled.
- Framework text is domain-neutral. Host vocabulary comes in through options
  (`system`, the loop's `correctives`, the summarizer's `instructions`).
- Annotate every parameter whose meaning or format is not obvious from its
  name. The JSON Schema the model sees keeps types and required keys but not
  every check: state a required format (a hash, a locator) in words.
- `Failure.error` is PascalCase (`NotFound`, `ToolInactive`); `message`
  names what is wrong and the call that fixes it. Never `Cause.pretty`
  output, stack frames, host paths or internal `_tag`s: text from a cause is
  `reasonOf(cause)`, from a defect `toFailure(defect)`.
- Guidance a capability needs at all times goes in its tool descriptions or
  a section it contributes, never in an always-on skill's `instructions`.
- Tools only grow within a conversation: restrict a step with tool choice or
  a handler failure, never by removing a schema (it rewrites the cached prefix).

## 3. Keep trusted and untrusted text apart

Untrusted: tool output, file contents, workspace SKILL.md files, task
replies, inbox items, transcripts, summaries a model wrote, third-party MCP
descriptions. Use core's helpers (`packages/core/src/turn/model-text.ts`,
exported from `@xandreed/core`); never hand-roll a frame or a marker.

- `framed(tag, text)` puts untrusted text inside `<tag>…</tag>`, each on its
  own line, after `escapeFrame(tag, text)` made any copy of the tag inside
  it inert. The tag is lowercase with a hyphen (`task-output`,
  `conversation-transcript`).
- Say once, before the frame, that its content is data and gives no
  instructions. Order: instructions, the rule, the framed data, then a
  one-line final directive (`Reply with the summary only.`).
- Text the host adds as a user-role message is `hostNote(text)`
  (`[Host note: …]`). Never label derived text "System note" or "source of truth".
- Bound every input (the user request too) with `clipTo(text, max)`, which
  leaves a counted `clippedMarker`, `[… 1234 characters clipped]`, never a
  bare `…`.
- House examples: `summaryPrompt` (`plugin-memory-summary/src/plugin.adapter.ts`),
  `handoffToMessage` (`core/src/internal/mapping.entity.functions.ts`), the task result in
  `plugin-tasks/src/task.entity.functions.ts`.

## 4. Tier, order, version

- `static` is the cacheable prefix: byte-stable for a given agent config.
  Text that varies per session or config goes in `session`; per-turn state
  in `turn`.
- `order` comes from a config option with a default (`sectionOrder`,
  `catalogOrder`). Shipped: 800 `workspace.environment` (session), 850
  `workspace.skills.always` (static), 900 `tool-discovery.catalogue` (static).
- The turn records each section's id, `version` and text fingerprint
  (`SystemPrepared`). Bump `version` when the template's wording or shape
  changes; config-driven differences are already in the fingerprint. Views
  and digests carry a `version` too: bump it the same way.
- Sort ids by code unit (`Order.String`), never `localeCompare`.

## 5. Pin it

- Beside the text, an exact assertion: `toBe` on the whole string, or
  `toEqual` on the whole object. Examples: the summarizer prompt in
  `plugin-memory-summary/src/plugin.adapter.test.ts`, the task tool
  descriptions in `plugin-tasks/src/tasks-capability.adapter.test.ts`.
  `toContain("## Workspace")` is not a pin.
- If the golden agent uses it (see the imports of
  `packages/sdk/src/agent.golden.test.ts`),
  `packages/sdk/golden/agent-turn.model.json` pins it byte for byte. For a
  deliberate change:
  ```bash
  EFFERENT_UPDATE_MODEL_GOLDEN=1 bun test packages/sdk/src/agent.golden.test.ts
  git diff packages/sdk/golden/agent-turn.model.json
  ```
  Read every changed string and explain it in the PR. Never re-record to
  silence a failure you cannot explain. `EFFERENT_UPDATE_GOLDEN=1` (the
  journal golden) is for deliberate storage changes only.
- A row in the package `AGENTS.md` "Model-facing text" table: the text,
  its source (`file:line`) and, under "Pinned by", the test that pins it
  (`exact, src/x.test.ts:12`) or the golden. `scripts/model-text-pins.test.ts`
  fails on a cell that says `unpinned`, `contains`, `codes only` or
  `by reference only`, and on a cited test file or line that does not exist.
- CHANGELOG entry under Unreleased naming the text that changed.

## Checklist

- [ ] Lives in one place (a description builder, view, failure or prompt function), not inline in logic
- [ ] Names only visible tools and headings; domain-neutral
- [ ] Non-obvious parameters annotated; formats stated in words
- [ ] A failure says what to do next; no internals
- [ ] Untrusted content `framed`, introduced as data, bounded with `clipTo`; host text is `hostNote`
- [ ] Right tier; `version` bumped if the template changed
- [ ] Exact test, or the golden re-recorded and reviewed; CHANGELOG entry
- [ ] `bun run typecheck` and `env -u HTTP_PROXY -u HTTPS_PROXY bun test`
