# ADR 0022: Memory is kept by a curator, after the turn

- **Status:** accepted, 18 November 2026
- **Applies to:** `@xandreed/sdk/kernel` (the knowledge contract: its records, folds, prompts and checks, the
  `Curator` contract and its kit `curatorConformance`)
- **Supersedes:** ADR 0019 (what an agent knows as links the model writes with a tool). Its code stays until the
  lessons that use it are moved
- **Takes up:** ADR 0008's "What would reopen this" (a memory that must call a model outside any turn's context call)
- **Narrows:** ADR 0001's rejection of listeners that append to the journal during a turn, and the same line of skill
  `kernel-architecture`'s "Do not add" list
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

What an agent knows across conversations has been written by the agent itself, with tools: `rememberFact` stores a
sentence (ADR 0014), `linkThings` a link between two things (ADR 0019). Both leave the keeping of the memory to the
model that is busy answering. Three things follow from that.

- **A model writes when asked, and does little else.** ADR 0019 measured that DeepSeek V4.1 Flash called `linkThings`
  in 9 tries of 9 when a message stated a link. Lesson 18 records what it did afterwards, on the same model: told "Ana
  works at Acme. Acme is in Lisbon.", then later "Ana still works at Acme, and she has a dog called Rex.", it stored
  the dog and called nothing for Acme, in 5 runs of 5, and told "Remember: Ana works at Acme." it called nothing, in 2
  of 2. So how often a thing was said is not counted, though the graph has a record for it. No recorded run shows a
  model removing a link that stopped being true without being asked to; that was never measured.
- **Nothing ends.** A fact or a link is removed by its id, and then it is gone from what a reader folds. "Ana lives in
  Porto" and "Ana lives in Braga" both stand until a model thinks to remove one, and when it does, no record says
  what replaced what, or when.
- **A sentence and a link are two memories of one thing.** A host that uses both stores "Ana works at Acme" twice,
  ranks each in its own way and sends two notes.

A memory that stays right needs work the answering model does not do: compare what was just said with what is
stored, count what was said again, end what changed, and tell two people with one first name apart. That is a
second piece of work, done after the answer. ADR 0008 named it as what would reopen its decision: a memory that
must call a model in the background, outside any turn's context call.

## Measured before deciding

Measured on 18 November 2026, with DeepSeek V4.1 Flash through the AI Gateway at temperature 0, reasoning off unless
said. All but the first were measured on scratch code written before this cut, which the kernel's functions are a
rewrite of; their prompt differs from the measured one in the ways the "Decision" lists. The first is the kernel's
own:

- **The kernel's own score.** The same 40 turns through `shownFor`, `curationPrompt` and `reviewPrompt` at
  `KNOWLEDGE_PROMPT` 1, `curationOf`, and `staged` at `KNOWLEDGE_CHECKS` 1, two runs each way: 36 and 36 of the 40
  turns right in full with one call, 39 and 39 with a review call. That is within the noise of the prototype's
  numbers below and no better than them: it is the set the prompt was written on. The turn that was wrong in every
  run was wrong in the prototype's last runs too: "Carla Mendes told me she loves living in Lisboa" is written as a
  new preference, and the stored "Carla Mendes lives in Lisbon" is not listed as said again. In the review runs the
  first call made the plain runs' mistakes (for "Bruno Reis left Acme Labs", two or three ends of memories that only
  depend on his job; in two turns, a question counted as a restatement), and the second call removed them, both
  times. It also reworded two or three sentences and wrote one hedged memory the first call had left out ("if they
  ever move, it would probably be to Lisbon"), which the set allows either way. Every reply decoded, and the checks
  dropped nothing. About 1.1 seconds and $0.0004 a turn with one call, 2.2 seconds and $0.0007 to $0.0010 with two.
  Not on the measured path: `turnSource` (the turns are scripted, and their parts were written as it writes them),
  `knowledgeOf` (the stored memory was handed over as the fold gives it, each memory said on its scripted day) and
  `draftsOf` (each turn started from the memory as it should stand, so nothing stored was read back). Tests hold
  those three; no model has run through them.

The set: 40 scripted turns in 6 conversations between a user and an assistant, about the user and the people of the
learn track's world, with what each turn should add written down before the prompt was. They hold new facts, things
said again, changed and corrected, other spellings of a name, pronouns, relative dates, two people called Ana, small
talk, the assistant's own guesses, tool results, and "forget that". The memory under them was written by a script from
the learn track's world: 395 entities and 711 memories, 3 of them ended. Two of those entities should not have been
made (a second "Porto", and a person called "Rex" who is a pet) and three memories are about them; every number here
was measured with them in place. The last ten turns were meant to be held out and were not kept clean: one sentence of
the prompt and part of another came from two of them after the first runs. Forty turns is a small set, and one model
is one model.

- **What the curator is shown.** For the 20 stored memories a turn says again, ends or must leave standing, the 12
  memories nearest the turn by shared words held 17 of 20, the 12 nearest by meaning (e5-small) held 15 of 20, and
  everything stored about the entities the turn or the two turns before it name, up to 30 each and 40 in all, held 20
  of 20, on a set of 40 turns where nobody had more than 30 memories. "And she moved to Braga last month" shares no word with
  "Ana Silva lives in Porto".
- **One call a turn.** With one call and reasoning off, 35 and 36 of the 40 turns were right in full over two runs;
  with reasoning on, 38; with one call and a second call that reviews the first, 38; and with nothing ever ended (each
  change written as one more memory), 37: all on 40 scripted turns and one model, where the two runs of the first
  differ by one turn, so the others are just above the noise of a set this small. Every one of those replies decoded
  as JSON.
- **What a review does.** On those 40 turns the plain call ended too much (three wrong ends in each of its two runs:
  "Bruno Reis left Acme Labs" also ended three memories about his commute to its office) and counted a question as a
  restatement (two in each run). The review call removed all of those, in the same three turns each time, and
  restored no omission: "Ana is thinking of quitting her job" was not stored in 3 of 8 runs over the same small set,
  two of them review runs.
- **What it got right in every arm.** 25 or 26 of the 26 new memories the 40 turns hold were written, and 7 of their
  7 dates were turned into days ("last month" to 2026-10), which is few of each. The right stored entity was used
  each time and no second one made, for two Anas, a misspelt surname and a name without its accent. Nothing was
  stored for small talk, a question, the assistant's guess or a looked-up capital, on those 40 turns.
- **Cost.** About 1.1 seconds and $0.0006 a turn for one call, about 2.2 seconds and $0.0013 with a review, on that
  one model and those 40 short turns.
- **The page's small model.** SmolLM2 360M, the small model a lesson page runs on a CPU, answered 0 of 6 turns with
  JSON, a very small set of which none decoded: it repeated parts of the prompt.
- **Questions that need two memories.** On 14 such questions over the scripted memory ("Which city is Carla Novak's
  employer headquartered in?"), a small set on one model, whose memories were short sentences ("Hooli is in Munich")
  and so an easy target for a second search, the model answered 1 or 2 from the note it was sent (two embedders), 5 or
  6 when the note also held a short walk from what was found, and 11 to 13 when it could call a recall tool again (12
  or 13 with the walk too).

## Decision

- **Memory is written after the turn, by a curator the host provides, never by the agent's tools.** A turn is
  answered first. Then what was said is stored as a source, a curator reads it beside what is already stored, and
  what it proposes is checked and appended. The agent that answers is given no tool that writes memory.
- **The curator is a contract, `Curator`**: `curate({ prompt, job })` to the model's reply as text, failing with
  `CurationFailed`. The kernel calls no model (ADR 0004): the host provides the curator over the model it picked, with
  its own budget and tracing, as it provides a `Summarizer`. `job` names the source, the try and the purpose
  (`extract`, or `review` for a second call). `curatorConformance` holds an implementation to it.
- **A journal of its own**, the knowledge session (`KNOWLEDGE_OWNER`, `plugin.knowledge`), as facts and links have
  theirs (ADR 0014): there is no store beside the journal. Eight records, all tagged `memory`:

  | Record | Says | May be skipped |
  |---|---|---|
  | `plugin.knowledge.source` | what was said, in parts, each with who said it (`user`, `tool`, `assistant`, `host`), what came before, and when | no |
  | `plugin.knowledge.entity` | a named thing: its id, name and kind | no |
  | `plugin.knowledge.aliased` | another name an entity bears | yes |
  | `plugin.knowledge.memory` | a sentence, its kind, the entities it is about, the quote it rests on and who said it | no |
  | `plugin.knowledge.restated` | a standing memory was said again | yes |
  | `plugin.knowledge.ended` | a memory no longer stands: why, and what replaced it | no |
  | `plugin.knowledge.curated` | a source was read, and what the checks dropped | no |
  | `plugin.knowledge.failed` | a try at a source failed, and why | no |

- **A memory is a sentence about entities.** One line of at most 300 characters that can be read alone, with a kind
  (`fact`, `preference`, `decision`, `goal`, `event`, `profile`) and the ids of up to eight entities it is about. An
  entity is a person, a place or any named thing, with the other names it bears; the user is entity `n1`, which no
  record stores. A memory about two entities is what joins them in this cut, which has no record for a relation.
  Whether one is added beside the sentences is not decided here ("Left open").
- **Every memory rests on a quote** from its source, and the quote must be the user's, a tool's or the host's words,
  never the assistant's. A source is stored in parts for that reason. A host may write a source itself (a decision it
  recorded, a note): one part said by `host`.
- **Nothing is deleted: a memory is ended.** A memory that changed, was wrong or was asked to be forgotten gets a
  `plugin.knowledge.ended` record with the reason and, when something replaced it, that memory's id. Its own record
  stays. `knowledgeOf(journal)` folds every memory with how often and when it was said and how it ended; `standing`
  gives those that stand, and `endedBy` what a memory replaced. So a wrong end is undone by reading the journal, and a
  question about how things were can be answered. On the prototype's journals the two ways answered alike (17 of 18
  questions each, a small set on one model), so this is chosen for what the journal can say, not for a better score.
- **The curator is shown what is stored about the entities named** (`shownFor`), not the memories most like the
  turn: the user; the entities the source names in full; those its context names; people whose first name it holds;
  and their memories, up to 30 for each and 40 in all. Names are compared folded: case, accent marks and punctuation
  do not tell names apart, in any script.
- **The prompt is the kernel's** (`curationPrompt`, `reviewPrompt`), pinned word for word, with a version
  (`KNOWLEDGE_PROMPT`). Its seven rules are the measured ones but for these changes: the kinds of entity it offers no
  longer hold `pet`; a memory may carry the day it is on (`on`); a line the host recorded (`Host:`) is evidence beside
  the user's words and a tool's result; the frames have hyphenated tags, which the kernel's `framed` can make inert
  (`<this-turn>`, `<curation-task>`, `<proposed-update>`); a memory about nothing reads `about nobody`; and the review
  prompt says what to do before the data, where the measured one said it after. What is shown is chosen from what
  was said without the labels a curator reads it under (`User: `, `Tool `), which the prototype counted as words.
- **The checks drop a bad item alone** (`staged`, at `KNOWLEDGE_CHECKS`). A reply is read item by item
  (`curationOf`): an item of the wrong shape is left out and counted. Then each item is checked on its own against
  the source and what the curator was shown, and one that fails is dropped with its reason while the rest is kept: a
  memory whose quote is not in what the user, a tool or the host said; one about an entity that was not shown; an end
  of a memory that shares no entity with the new one. A new entity whose name a stored one bears is that entity, and a
  sentence a standing memory already has is a restatement. `draftsOf` then makes the records, reading the knowledge as
  it stands when they are stored, since it may have moved while the model answered.
- **This cut is the pure core.** Records, folds, the two prompts, the reply's reader, the checks and the `Curator`
  contract with its kit. It adds no listener, no service, no tool and no recall. The service that hears a turn end and
  curates it, and the plugin around it, come next, with how memories are recalled for a request.

## Rejected

- **The agent's own tools**, as ADR 0014 and ADR 0019 have them. The measurements in "Context": a model writes a
  link when told one and does not say it again, and whether it ends one was never measured. The work is also paid
  for in the answer's own time, by the model that should be answering.
- **A top-k of candidates** by shared words or by meaning, as what the curator is shown: 17 and 15 of 20 against 20
  of 20, on a small set where nobody had more than 30 memories. The memory a turn changes is often the one least like
  it.
- **Deleting on a correction.** A wrong end could not be undone, and "where did she live before?" would have no
  answer. The model ended too much in every plain run.
- **Never ending anything** (each change one more memory). It scored 37 of 40 scripted turns, as the others did
  within the noise of so small a set, and its answers were as good. It leaves every reader to work out from dates
  which of two memories is true.
- **A curator on the page's small model.** 0 of 6 replies decoded, on six turns and one small model. A lesson page
  with no key shows a scripted curator.
- **A review call the kernel always makes.** It doubles the cost for two or three turns in forty, on one model and
  one small set.
  `reviewPrompt` is there, and whether to use it is the host's.

## Left open

- **A relation record** (a subject, a relation and an object, beside the sentences). This cut has none: two
  entities are joined by a memory about both. For it: a reader could follow a link without reading a sentence, and a
  graph could be drawn from records. Against it: two forms of one memory to keep in step. What was measured does not
  settle it. The two-memory questions such a record would serve were answered by the agent searching again in 11 to
  13 of 14, against 1 or 2 from the note alone; but that is one model, DeepSeek, over short sentences that are an easy
  target for a second search, and a model that calls no tool answered 5 or 6 of 14 with the walk alone. It is decided
  with how memories are recalled, in the record that comes with that cut.

## Consequences

- **One or two more model calls a turn, after the answer.** A turn that adds nothing costs a call too: the curator
  must read it to know. A host that will not pay that for every turn curates fewer of them.
- **When a memory was said is when its source happened** (the source's `at`), not when a record was stored: a turn
  curated a week late is still said on its own day, and what it ends ended that day. A host that writes a source
  itself gives that time.
- **Memory lags the conversation by one curation.** What a turn said is not in memory while it is being answered, and
  not until its curation is stored. The conversation's own journal still holds it.
- **A host with many users and no worker can curate later, from the journal.** A source is stored before the model
  is asked, and its state is folded (`Pending`, `Curated`, `Failed` with its tries), so a source that was never
  curated is found again after a restart.
- **A curator's mistake is a record.** A wrong memory, a wrong end and a missed restatement are all in the journal
  with their source and quote, and each can be ended or read past. An omission leaves no record: on the 40 turns
  above one sentence was left out in 3 of 8 runs, and a review did not bring it back.
- **The checks cannot tell a true sentence from a false one.** They hold a reply to its source and to what was
  shown. A memory whose quote is in the source and whose sentence says something else passes.
- **A tool call's parameters count as the tool's words.** A turn's tool part is one text, the call and its result
  (`<name>, called with <parameters>, returned: <result>`), and a quote found anywhere in it passes as a tool's. The
  parameters were written by the model, so a guess it put in a search query can be quoted as evidence. Telling the
  two apart needs the call and the result stored as separate parts, which changes a stored shape: not done here.
- **Names in a script written without spaces are not found** as runs of whole words, so their entities are shown
  only through a context or a memory that names them. Quotes are compared without that rule, and hold in any script.
- **A memory about no entity is never shown to the curator again**, so nothing can say it again or end it. The
  prompt tells the curator to name the user or the thing a sentence is about where it can.
- **Someone with more than 30 memories** gets 30 places and the rest only while the 40 are not full, the ones that
  share most words with the source first. The measured set had nobody like that: the user's own entity will be the
  first, and then a choice among its memories is needed again.
- **Facts, links and recall by meaning stay as they are** (ADRs 0014, 0019, 0021) until the lessons that use them
  are moved to this. Nothing here reads or writes their journals.

## What would reopen this

- A model that keeps its own memory right with tools: says again, ends and merges without being asked, measured on
  the turns above.
- A user with hundreds of memories, where what is stored about the entities named no longer fits what a curator can
  be shown: a choice among them, measured.
- A cost of one call a turn that a host cannot pay, and a cheaper test of whether a turn holds anything to keep.
- Entities in scripts written without spaces, for a host that needs them found by name.
- A request to erase what was said: ended memories and their sources stay in the journal, as ADR 0014 says of facts.

A change to this decision is a new record that supersedes this one; this one is not edited.
