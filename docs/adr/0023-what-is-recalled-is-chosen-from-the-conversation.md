# ADR 0023: What is recalled is chosen from the conversation

- **Status:** accepted, 18 November 2026
- **Applies to:** `@xandreed/sdk/kernel` (the knowledge contract's curation step `curate`, `curateAgain`,
  `knowledgeSession` and `knowledgeJournal`; its recall `askedOf`, `seedsOf`, `keywordScores`, `recallKnowledge`,
  `knowledgeNote`, `knowledgeRecalledOf` and the live event `plugin.knowledge.recalled`; the memory wrapper
  `withKnowledge`)
- **Takes up:** ADR 0022's "This cut is the pure core" (the service that curates a turn, and how memories are
  recalled for a request) and its "Left open" (a relation record)
- **Leaves as they are:** ADR 0014 (facts), ADR 0019 (links; its code stays until the lessons that use it move) and
  ADR 0021 (recall by meaning)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

ADR 0022 moved the keeping of memory out of the turn: a curator the host provides reads each turn after it is
answered, and what it proposes is checked and stored in the knowledge session. It stopped at the pure parts: a host
wrote the flow that puts them together itself (`keep` in the kernel's test), and nothing sent what was kept to a
model. Two things are left.

- **Curating a turn** is the same few steps in every host: store the source, ask the curator, read and check the
  reply, store what passed and that the source was curated, or that the try failed. Two hosts would copy it.
- **What a request is sent.** The memory is sentences about entities. The lesson that showed links ("A memory that
  connects") sent what a walk over links from the question's words reached, and the agent wrote the links itself
  with tools. With the curator keeping the memory, the agent should be sent, with no tool call, what is stored about
  what the conversation names, and a question that needs two memories ("In what city does Ana Silva work?", with "Ana
  Silva works at Acme" and "Acme is in Lisbon" stored) should find both.

Recall by meaning (ADR 0021) needs an embedder: a model in the page or a service. This cut is recall without one,
which every host can run and which a page can run with no model loaded.

## Measured before deciding

Measured on 18 November 2026 with no model and no embedder, over a memory written by a script from the learn
track's world: 395 entities and 711 memories, 708 of them standing, the user's entity with none. A question is
found when the memory it needs (both, for one that needs two) is among those sent. The question sets: 25 single
questions, 14 that need two memories, 24 follow-ups (the last message names nothing; the turn before does), 39 asked
after an unrelated turn, and 94 two-step questions generated from the memory's pairs of sentences ("Which city is
Carla Novak's employer in?"). They were written for the earlier measurements, before this recall; the generated ones
come from templates, which favours any walk that follows a sentence's subject.

The first decisions were made on scratch code, where a word of BM25 counted only where a sentence held it as it
is, seeds were full names alone, and only standing memories were ranked: the rows marked † were run through the
kernel's own functions at that point, over the same memory with the 44 English stop words and the speaker's words
of the measurement (`i`, `me`, `my`, `mine`, `myself`), and gave the same counts, set by set. The rows marked ‡ are
the kernel as it ships, after the three changes the second table measures. The other rows are arms the kernel's
recall cannot be set to (a list left out, the walk inside the places, the walk from another list), counted by the
scratch code alone.

| What is sent | single (25) | two (14) | follow-ups (24) | after an unrelated turn (39) | generated two-step (94) |
|---|---|---|---|---|---|
| memories about a seed, 8 places, no walk | 15 | 0 | 13 | 15 | 0 |
| the two lists fused, 8 places, no walk † | 20 | 1 | 13 | 17 | 0 |
| the two lists fused, 11 places, no walk † | 20 | 1 | 16 | 21 | 0 |
| the two lists fused, 8 places, then a walk by subject of up to 3 more † | 20 | 8 | 14 | 24 | 71 |
| the same walk taking 3 of the 8 places | 19 | 7 | 10 | 22 | 71 |
| the walk from the fused list's three best, not the seed list's, 3 of 8 places | 19 | 8 | 10 | 21 | 44 |
| memories about a seed alone, then the walk, 3 of 8 places | 14 | 7 | 10 | 21 | 71 |
| the chosen recall with no stop words † | 18 | 7 | 14 | 21 | 77 |
| the kernel, 8 places, no walk ‡ | 20 | 1 | 22 | 17 | 0 |
| the kernel, 11 places, no walk ‡ | 21 | 1 | 22 | 22 | 0 |
| **the kernel: 8 places, then a walk by subject of up to 3 more** ‡ | **20** | **8** | **22** | **24** | **78** |
| the kernel with no stop words ‡ | 18 | 7 | 22 | 21 | 85 |

Three changes were then measured one by one on the same sets, each kept only if no set dropped, and on 18 questions
about what the curator wrote for ADR 0022's 40 turns (over those memories: 740, 10 of them ended; a question is
found when a sentence sent says what it asks, and one about something forgotten when nothing sent says it):

| Recall, 8 places and a walk of 3 | single | two | follow-ups | unrelated | generated | curated (18) |
|---|---|---|---|---|---|---|
| the first cut (†) | 20 | 8 | 14 | 24 | 71 | 13 |
| words that start one another meet in BM25 | 20 | 8 | 22 | 24 | 78 | 13 |
| a person's first name seeds | 20 | 8 | 14 | 24 | 71 | 13 |
| both | 20 | 8 | 22 | 24 | 78 | 13 |
| an ended memory ranks for what replaced it, alone | 20 | 8 | 14 | 24 | 71 | 14 |
| **all three (the kernel)** | **20** | **8** | **22** | **24** | **78** | **16** |

- **Words that meet.** "In what city does Ana Silva work?" held no word of "Ana Silva works at Acme" but her name,
  so over the world's 557 memories it was sixth of her memories, the walk had no bridge, and nothing about Acme was
  sent; with "work" meeting "works" it is first, and the walk starts from Acme. The follow-ups ("And where does she
  live?") gain 8 of 24 the same way. The rule is `shownFor`'s: the same word, or both four characters or more and
  one the start of the other, in how often a sentence holds a word and in how many do alike.
- **First names** change none of these sets, which name people in full; they are for "Where does Ana work?", which
  named nobody before (8 memories sent that merely held "Ana") and now seeds both Anas, their employers first.
- **An ended memory ranks for what replaced it.** On the curated questions, "Where does Ana Silva live now?" found
  "Ana Silva moved to Braga in October 2026" only when the ended "Ana Silva lives in Porto", which shares the
  question's words, took a place for it; "Does he still live in Porto?" and "Where does Bruno Reis work now?" the
  same. No old memory was sent as standing either way. The two curated questions still missed ask for what nothing
  stored says ("what does she think of her job") or what no word reaches ("food I should avoid" against "can't
  stand coriander").

Over the first table:

- **The list the message's words reach** (BM25) adds 5 single questions to the list about a seed (15 to 20), and
  costs nothing elsewhere.
- **The walk** is what answers two memories: 1 of 14 to 8, and 0 of 94 to 71. Three more plain places give 1 and 0:
  it is where the places go, not how many. On top of the 8 it loses nothing; taking 3 of the 8 lost follow-ups (14
  to 10).
- **Walking from the memories about a seed**, not from the fused list's best, found 71 of 94 against 44: the fused
  list's best are often memories that merely share a word.
- **Stop words** move the counts both ways (single 20 to 18, generated 71 to 77): they are the host's, in its
  language, and the counts above are with English ones.
- **What a walk can reach.** Counted earlier over the same 94 questions, with an embedder ranking instead of BM25:
  taking the memories nearest the question about any entity the best hits are about put both memories among eight
  in 19 to 23 (two embedders); taking those whose first `about` is the entity the hits bring in, 66 to 75; only the
  memories that join two entities among those, 78 to 89; and ranking those by the relation the script wrote, a
  typed record's best case on templated questions, 89 to 93. The label added 4 to 11 of 94 over the same
  candidates; most of what a relation would give a walk is in which entity a sentence names first.
- **The first `about` is the subject.** In the curator's replies to ADR 0022's 40 turns, the entity a sentence names
  first was first in `about` in 72 of 72 memories about two or more, though the prompt does not ask for it.
- **The speaker's words.** Measured earlier with embedders, on a memory the curator wrote where the user had 12
  memories: reading "I", "me" and "my" as the user's entity found the user's own facts in 6 of 6 questions that say
  them, against 4 or 5 without, and lost no question about someone else; it took about 2 of 8 places for the user's
  memories when "my friend …" was about the friend.
- **Answers.** On the 14 questions that need two memories, one model (DeepSeek V4.1 Flash) answered 1 or 2 from a
  note of the 8 nearest by meaning, 5 or 6 when the note also held a short walk, and 11 to 13 when it could call a
  recall tool again (ADR 0022). No model answered from this recall's note in this measurement.
- **Cost.** About 3 ms for one recall over the 711 memories (2 ms for the first cut), on one machine; the fold of the knowledge session's
  journal comes before it, once per request.

What others published, read for the relation record: no study isolates a relation's label. Relation triples alone
did much worse than plain text in a third party's comparison; where graphs help questions of two steps, the edge
leads back to text, and variants without relations match them (their authors' own results); and the one vendor that
measured typed triples beside sentence memories reported lower scores on questions of two steps, and later replaced
the triples with links between entities.

## Decision

- **The curation step is a function of the knowledge contract, `curate(session, source, options)`**, which a host's
  program calls after a turn is answered: the source is stored first, in a turn of the knowledge session, where it
  takes its id; the host's `Curator` is asked with `curationPrompt` over `shownFor`, and, unless `review` is
  `false`, again with `reviewPrompt`; the reply is read with `curationOf` and checked with `staged`, and what passed
  is stored in one turn with `draftsOf`, then `plugin.knowledge.curated`. When a call fails (`CurationFailed`) or a
  reply holds no JSON object, `plugin.knowledge.failed` is stored with the try and the reason, and nothing else. It
  answers a `CurationOutcome` (`Curated`: what was shown, the calls, what the checks dropped and what was stored;
  `Failed`: the try and the reason); a store that fails is its failure. The model calls run outside any turn of the
  knowledge session, which takes one turn at a time. `curateAgain(session, id)` takes up a stored source no
  curation kept, its try one more than those that failed. No listener and no fiber of the kernel's: a host decides
  when to curate, and a page shows the curator's turn as its own.
- **Review is on unless a host turns it off.** Measured in ADR 0022: 39 of 40 scripted turns right with a review
  call against 36 with one call, for about twice the cost and time.
- **A review whose reply holds no JSON object fails the try**, as an unreadable first reply does: the unreviewed
  proposal is what a review exists to correct (ends of memories that only depend on what changed, a question taken
  for a restatement), so it is not stored in its place. The source is `Failed` and can be tried again.
- **An interruption stores nothing after the source**: no `failed` record, so the source stays `Pending` and
  `curateAgain` takes it up. The turns that store a curation's records, or its failure, are not cut short once
  begun: memories stored without the `plugin.knowledge.curated` that closes them would be curated again, and their
  sentences counted as said again.
- **A source is stored with its fields by name**: a host's value may hold more (a turn's source carries its text
  beside its parts), and that is never stored.
- **The knowledge session is the first by creation whose owner is `KNOWLEDGE_OWNER`** (`knowledgeSession`), created
  when there is none, as the facts' memory session is; `knowledgeJournal` reads it and creates none.
- **Recall calls no model and no embedder.** `withKnowledge(options)` is a memory wrapper that, for each request,
  folds the knowledge session, reads the conversation from its journal (`askedOf`: the person's last message, as
  `questionOf` reads it, and the turn before), chooses what to send (`recallKnowledge`) and adds `knowledgeNote` of
  it last, as `withFacts` does. Its options, refused in words where written: `limit` (1 to 50, 8), `walk` (0 to 10,
  3), `speaker` and `stopWords` (each one word; none).
- **The seeds** are the entities the last message names, by name or another name they bear, as a run of whole
  words, folded as `shownFor` compares names; the user's entity when the message holds one of the host's speaker
  words; when it names nobody in full and holds no speaker's word, the people (kind `person`) whose first name it
  holds, a whole word of three letters or more, as `shownFor` reads one (`first-name`); and only when none of those,
  the entities the turn before names (the person's messages and its answer). The user's entity is never named by a name: its own ("the user", "I", "me") are the
  curation prompt's English, and which words name the user is the host's to say. The speaker's words are not read in
  the turn before, where its answer's "I" is the assistant.
- **Two lists, fused by rank.** The memories about a seed, and every memory the last message's words reach by BM25
  (the kernel's own, `k1` 1.2, `b` 0.75, a word folded and more than one character, the host's stop words passed
  over, a word meeting one it starts or that starts it when both are four characters or more, in how often and in
  how many sentences alike); each ordered by that score, then how often said, then the latest said. The candidates
  are the memories that stand and those that ended as `changed` with a standing memory as what came in their place
  (followed through), BM25 counted over them all; an ended one takes its place for the standing memory that
  replaced it, which keeps the first place it or one it replaced took. A memory at place `p` (from 0) of a list adds `1 / (10 + p)` for the list about a seed and
  `0.5 / (10 + p)` for the words'. The first `limit` of the fused list are sent.
- **The walk by subject.** The entities the three best memories about a seed are about, but the user's and those the
  last message named, are bridges; up to `walk` more standing memories whose first `about` is a bridge, not already
  sent, best by the same order, are sent after the `limit`, on top of it. A seed from the turn before can be a
  bridge, since the last message did not name it.
- **An ended memory is never sent alone.** When one would rank, what replaced it is sent in its place (the 18
  curated questions: 13 found without it, 16 with it and words that meet). Each memory sent carries those it
  replaced (ended as `changed`, with it as what came in their place, and what those replaced), newest first, at
  most `BEFORE_SHOWN` (3), sent under it as "before that", so a fact that changes often does not grow every note. A
  memory ended as `wrong` was never true, and one forgotten was asked to be: neither ranks nor is sent.
- **The note** (`knowledgeNote`) is `hostNote` text, then the memories framed in `<known-memories>`, a line each: its
  sentence and when it was said (`said on YYYY-MM-DD`, or `said N times, last YYYY-MM-DD`, the day of its source's
  `at`), and under it `  before that: <sentence> (<when said>, until YYYY-MM-DD)` for each it replaced. No ids: the
  model is given nothing to write back. Pinned whole.
- **What recall did is said live**, `plugin.knowledge.recalled`, tagged `trace`, never stored, for every request:
  what was asked, the options, the seeds and how each was named, the bridges and what brought each in, the memories
  it could send (those sent first, at most 100, the rest counted) each with its place in each list, its score and
  words, its place in the walk, its fused score, whether it was sent and why or why not, and what it replaced; the
  ids sent; and the note's tokens. A client draws a request's recall from it.
- **No relation record.** A memory about two entities joins them, and the walk by subject gets most of what a typed
  relation would give it (66 to 75 of 94 against 89 to 93 at a typed record's best). The walk relies on a memory's
  first `about` being its subject: the curator's replies wrote it so in 72 of 72, the prompt does not ask for it, and
  this cut does not change the prompt.
- **A memory that ends one about the same subject is right.** "The project was shut down this morning" ended "Bruno
  Reis leads Project Falcon" in all 8 runs of ADR 0022's later measurement. That is taken as the curator's call to
  make: a reader wants what holds now, and the ended memory is still there, sent under nothing but read back from the
  journal.
- **The graph contract stays as it is** until a later cut removes it with the lessons that use it.

## Rejected

- **A listener or a fiber that curates when a turn ends.** A host that answers first and curates after already knows
  when a turn ended; a listener would curate turns a host does not want curated, and needs a place to say it is
  running. ADR 0022's narrowing of the "Do not add" list stays open for a host that wants one.
- **Storing the unreviewed proposal when a review cannot be read.** See "Decision".
- **The walk inside the 8 places**: follow-ups 14 to 10 of 24.
- **The walk from the fused list's best**: 44 of 94 against 71.
- **More plain places instead of a walk**: 11 places found 1 of 14 and 0 of 94.
- **Ranking standing memories alone**, as the first cut did: 13 of the 18 curated questions against 14 (16 with
  words that meet); a question that reached only the old memory ("Where does Ana Silva live now?" against "Ana Silva
  lives in Porto") sent neither.
- **Words compared as they are** in BM25: follow-ups 14 against 22 of 24, generated questions 71 against 78.
- **A typed relation record.** See "Decision" and "Measured".
- **English in the kernel.** The user's names in the fold are the prompt's English; the speaker's words and the stop
  words are the host's.

## Consequences

- **A question whose words the memory does not hold finds nothing by its words.** "Who employs Ana Silva?" holds no
  word of "Ana Silva works at Acme" but her name: the name finds it, and a question that names nobody and says
  "employs" finds nothing. Recall by meaning is what reaches it.
- **The places are fixed, not a budget.** Eight memories and three walked, each one line: at most eleven lines and
  what they replaced. A host that needs fewer tokens lowers `limit` and `walk`.
- **A follow-up after an unrelated turn** reads the turn before, which the unrelated turn is: 24 of 39 found.
- **The user's memories take places** whenever a message holds a speaker's word, even when it is about someone else
  ("my friend Ana Silva"). With a dozen of the user's memories it cost no hit; with hundreds it would.
- **The walk takes what its subject's memories say most often and most lately**, when the question's words reach
  none of them. Over the world's 557 memories, "In what city does Ana Silva work?" walks from Acme to "Acme Labs
  partners with Globex", "Acme hosts meetup in Madrid" and "Acme was renamed Acme Labs", and not to "Acme is in
  Lisboa", said once and earlier: "city" is no word of it.
- **Every request folds the knowledge session's journal.** About 3 ms for the recall over 711 memories; the fold
  grows with the journal.
- **The page's curator and its recall are one host's choices.** A host with no review, other stop words, or another
  language's speaker's words gets other counts.

## What would reopen this

- Recall by meaning beside the two lists (a third list, measured as these were): a later cut's.
- A user with hundreds of memories, where the user's entity is a seed of every first-person message and its
  memories crowd the places.
- Another language: its stop words and speaker's words, and a script written without spaces, where names are not
  found as runs of whole words.
- A curator that does not write a sentence's subject first in `about`, which the walk relies on.
- Questions that turn on a relation itself (a former employer against the present one) measured at answer level.

A change to this decision is a new record that supersedes this one; this one is not edited.
