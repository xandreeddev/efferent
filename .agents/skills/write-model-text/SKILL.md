---
name: write-model-text
description: Rules and checklist for any text the model reads in efferent — tool and parameter descriptions, skill summaries and instructions, failed tool results, host notes, pointers, summary and curation prompts. Covers where text lands, voice, framing untrusted text with the kernel's hostNote/framed/clipTo, versions, and pinning with exact tests. Read before adding or changing such text.
---

# Write text the model reads

Model-facing text is a contract: changing it changes hosts' prompts and their
cached prefixes. Treat a wording change like an API change.

## 1. Know where it lands

| Text | Defined | Reaches the model as |
|---|---|---|
| Tool `description`, parameter `.annotate({ description })` | `Tool.make` in the plugin's `*.adapter.ts` (`plugins/tool-files/file-tools.adapter.ts`) | the tool schema, on every step the tool is offered |
| The system text | the host's program | the first message of every prompt, never stored |
| Skill `summary` | `defineSkill` | one line of `catalogue(skills)`, which the host puts in its system text |
| Skill `instructions` | `defineSkill` | the stored result of a `loadSkill` call |
| A failed tool result | a handler's failure with `failureMode: "return"`, the contract's fixed words (`NOT_A_FACT`, `notInWorkspace`, `APPROVAL_REFUSED`) | the tool result, stored by `callTool` |
| Pointers, notes, summaries | the memory contract (`pointerText`), `factsNote`, `knowledgeNote`, `reloadNote`, the summary memory's `summaryNote` | messages a memory adds to a context |
| Prompts for a host's helper model | `curationPrompt`, `reviewPrompt` (`contracts/knowledge/knowledge-prompt.entity.functions.ts`) | the host's `Curator`, which sends them to a model |

All of it lives in `packages/sdk/src`: core's kernel writes no text a
model reads.

## 2. Write it

- Second person, imperative, plain. A tool description says, in order: what
  the tool does, what it returns, its limits (interpolated from the
  constant, never restated by hand), and when to use another tool instead.
- Name only what the model can see in the same request: the tools offered
  and what the host's own system text says.
- Kernel text is domain-neutral. Host vocabulary comes in through options
  (a skill's instructions, the curation prompt's `instructions` and
  `kinds`, a host's own words).
- Annotate every parameter whose meaning or format is not obvious from its
  name. The JSON Schema the model sees keeps types and required keys but not
  every check: state a required format (an id such as `f1`) in words.
- A failed result names what is wrong and the call that fixes it. Never
  `Cause.pretty` output, stack frames, host paths or internal `_tag`s.
- Never interpolate a tag, code, enum value or reason name into a message,
  a view or a note (`${x._tag}`, `${reason}`): say it in words through a
  typed `Record<TheEnum, string>` beside the text, so a new value fails to
  compile until it has words (`DROPPED_BECAUSE`).
- Tools only grow within a conversation: restrict a step with tool choice or
  a handler's failure, never by removing a schema (it rewrites the cached
  prefix).

## 3. Keep trusted and untrusted text apart

Untrusted: tool output, file contents, task reports, transcripts, summaries
a model wrote, what a curator was told. Use the memory contract's helpers,
exported from `@xandreed/sdk`; never hand-roll a frame or a marker.

- `framed(tag, text)` puts untrusted text inside `<tag>…</tag>`, each on its
  own line, a copy of the tag inside made inert by its hyphen: a frame's tag
  always has one (`this-turn`, `task-result`, never `turn`).
- Say once, before the frame, that its content is data and gives no
  instructions. Order: instructions, the rule, the framed data, then a
  one-line final directive (`Reply with the corrected JSON object …`).
- Text the host adds as a user-role message is `hostNote(text)`
  (`[Host note: …]`). Never label derived text "System note" or "source of truth".
- Bound every input with `clipTo(text, max)`, which leaves a counted
  `clippedMarker`, `[… 1234 characters clipped]`, never a bare `…`, and
  never half a character.
- House examples: `reportText` (`contracts/task/task.entity.functions.ts`),
  `factsNote`, `reviewPrompt`.

## 4. Version

- A prompt whose wording a measurement chose carries a version
  (`KNOWLEDGE_PROMPT`): its measured rules change only with a new
  measurement and a new version (ADR 0022).
- Sort ids by code unit (`Order.String`), never `localeCompare`.

## 5. Pin it

- Beside the text, an exact assertion: `toBe` on the whole string, or
  `toEqual` on the whole object (`plugins/tool-files/file-tools.adapter.test.ts#readFile says what it reads`).
  `toContain("…")` is not a pin.
- A row in `packages/sdk/AGENTS.md`'s "Model-facing text" table names the
  text, source module and the tests that pin it, by title
  (`src/x.test.ts#<part of the test's title>`, several separated by `; `).
  `scripts/model-text-pins.test.ts` checks that each citation names exactly
  one `test`, `it` or `describe` of its file and that it holds an exact
  assertion (directly or through a helper of the file). Give a new text's
  pin a test of its own, titled for that text: a deleted assertion among
  several of one test still passes the check. This validates inventory
  evidence, not semantic coverage: review the whole rendered value against
  the row and keep parameterized cases for distinct template branches.
- A lesson of the learn track that shows the text pins it too (skill
  `add-lesson`).
- CHANGELOG entry under Unreleased naming the text that changed.

## Checklist

- [ ] Lives in one place (a description, a contract's constant or function), not inline in logic
- [ ] Names only what the model can see; domain-neutral
- [ ] Non-obvious parameters annotated; formats stated in words
- [ ] A failure says what to do next; no internals; no tag, code or enum value in the text
- [ ] Untrusted content `framed`, introduced as data, bounded with `clipTo`; host text is `hostNote`
- [ ] A measured prompt's version bumped with its wording
- [ ] Exact test and an inventory row; CHANGELOG entry
- [ ] `bun run typecheck` and `env -u HTTP_PROXY -u HTTPS_PROXY bun test`
