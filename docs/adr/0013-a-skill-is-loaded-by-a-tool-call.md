# ADR 0013: A skill is loaded by a tool call; what is offered is a fold of the journal

- **Status:** accepted, 15 November 2026
- **Applies to:** `@xandreed/sdk` (the skill contract, the `skills` plugin, a host's loop)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

An agent with many abilities should not send them all with every request. Each ability has
instructions and tools; sent always, they cost tokens in every prompt and crowd what the
model reads. Four things had to be decided: how the model learns what it could load, how it
loads one, where what it loaded is kept, and which tools a step offers.

The kernel has no tool service (ADR 0004): a tool is Effect AI's, offered and run by the
host's loop. The journal is the only state (ADR 0003), and what a tool declares in
`dependencies` is held by the compiler where `callTool` runs it (ADR 0007).

## Decision

- **A skill is a value in the host's code**: `defineSkill({ id, summary, instructions, tools })`.
  `summary` is one line; `instructions` are the host's own text; `tools` is an Effect AI
  toolkit of the skill's own tools (`Toolkit.empty` for instructions alone). There is no
  registry: skills are arguments.
- **One value holds the host's tools and its skills together**:
  `skills(base, ...skills)`. The whole toolkit, the catalogue, the handler of `loadSkill`,
  what a step offers and the memory wrapper all come from it, so a list of skills and a
  toolkit cannot disagree. It refuses, where it is written: no skill, a skill that is none
  (one written by hand is checked as `defineSkill` checks its options), two skills with one
  name, and a tool that two of the base, the kernel and the skills have.
- **The model reads a catalogue**: one line per skill, with how to load one. It is a string
  the host puts in its system text. It says nothing of which skills are loaded, so it is the
  same in every request.
- **A skill is loaded by a tool call.** `loadSkill({ skill })` answers
  `{ skill, instructions }`. That result is conversation: stored once, sent whole
  (`SentWhole`) in every later prompt, among the messages and never in a system text that
  would change. Loading a skill again answers the same again.
- **Nothing new is stored.** A skill is loaded because the result of the call that loaded it
  is in the journal: `loadedOf(journal)` is the fold. So a skill is loaded after a restart,
  and is not loaded in another conversation.
- **What a step offers is that fold.** `offered(journal)` is a toolkit of the tools no skill
  owns, then each loaded skill's in the order the skills were loaded. The loop reads it at
  each step and gives the same toolkit to the model and to `callTool`. Tools are added and
  none is taken away within a conversation.
- **A tool that is not offered is not run.** The offered toolkit is one Effect AI made of
  the tools it holds, so a call of any other tool fails as a call of an unknown tool does,
  and the model reads that failure. This holds in the step that loads a skill too: what is
  offered was read before the step.
- **Types.** The offered toolkit is typed as every tool it could hold. What a call of it
  needs (`ToolNeeds`) is what any tool of the whole needs, whichever are held now: never
  `any`, and never less than the tools it holds. So a program provides what a skill's tool
  declares, and that skill's handlers, whether or not the skill is loaded yet, and one that
  leaves either out does not compile. Nothing is asserted: the whole is Effect AI's `merge`
  with its type written out, and the offered one is its `make` over tools read one by one.
- **Each argument of `skills` keeps its own type.** A skill annotated `Skill`, a list typed
  `ReadonlyArray<Skill>` or a base annotated `Toolkit.Any` has lost its tools: they would be
  offered and run, with what they declare missing from what the program is asked to
  provide, and with no `any` for `callTool` to refuse. `skills` refuses such an argument
  where it is passed (`OwnSkills`), as `callTool` refuses a toolkit typed over `Tool.Any`.
- **When a memory no longer sends the instructions** (a compaction folded the load's result,
  a window dropped it), the skill is still loaded and its tools are still offered.
  `withReloadNote(memory)`, a wrapper of `Memory` (ADR 0005), adds one note for the request,
  last: which loaded skills' instructions are gone, and that `loadSkill` reads them again.
  The note names skills and holds no instructions, so its size is bounded by the skills'
  names; the instructions return as a stored result, as they first came.
- **A journal that names a skill the host no longer has** is read without it: its tools are
  not offered, the note does not name it, and nothing fails.
- **No kit of its own.** Nothing here is a contract a host implements. The wrapper passes the
  memory wrapper kit.

## Rejected

- **Instructions in the system text**, added when a skill loads. The start of the prompt
  would change with every load, and a provider's cached prefix with it.
- **A record of its own for a load.** The call's result already says which skill was loaded
  and holds what loading gives. A second record could disagree with it.
- **A registry of skills**, or a service a plugin adds skills to. Skills are the host's
  values; a list in code is enough, and it is what the types are read from.
- **Offering every tool and refusing a call of an unloaded skill's tool in the loop.** The
  model would be sent every schema, which is the cost skills exist to avoid.
- **"Loaded" meaning "its instructions are in the context".** Under a window or a compaction
  a skill would unload silently, a tool would be taken away within a conversation, and a call
  still in the context would name a tool no longer offered.
- **The wrapper sending the instructions again itself.** They would be sent whole at the end
  of every request once folded, outside any cached prefix, with no bound but the skills'
  length.
- **A toolkit typed over `Tool.Any` for the offered subset.** It would lose what the tools
  declare; `callTool` refuses such a toolkit (ADR 0007).

## Consequences

- A host's loop reads the journal once more per step, to know what to offer.
- A load that adds tools changes the request's tool definitions. Providers that cache the
  start of a prompt count the tool definitions as part of it, ahead of the system text and
  the messages (Anthropic's order is tools, system text, messages; OpenAI's cached prefix
  holds the tool definitions too). So the request after such a load is a cache miss, once
  per load, and the requests after it reuse the new start. A skill that is instructions
  alone adds no tool and costs none. Offering every tool always would cost no miss and send
  every schema in every request: the trade is the host's, by which tools it puts in skills.
- The tools already offered keep their order when a skill loads: the new ones come after.
- The model pays a step to load a skill, and the instructions are in every later prompt of
  that conversation while the memory sends them.
- The offered toolkit's type names tools that may be absent at run time: its `tools` are
  typed as the whole's. A call of an absent one fails, as said above; reading `tools` by a
  name is not how a loop uses it.
- A skill's tool that declares a service makes the whole program need it, loaded or not.
- The note `withReloadNote` adds comes after the context a memory returned, so a memory's
  budget does not count it. It is one line, with the names of the skills it is about.
- Skills only load in this cut: nothing unloads one but a new conversation.
- `loadSkill`'s answer is a shape journals keep. A change of it takes a new tool name, as a
  plugin's record that changes shape takes a new name (ADR 0008).

## What would reopen this

- A host with so many skills that the catalogue itself is too long: a search over skills, or
  a catalogue in parts.
- A skill that must be unloaded, to take its tools away: a record for it, and a rule for the
  calls still in the context.
- Instructions too long to send whole: a skill in parts, read on demand, as a long result is
  (ADR 0011).
- A branch of a conversation (a copy of its journal): it inherits what was loaded, since the
  results are copied with it. If that is wrong, the fold needs a rule.
