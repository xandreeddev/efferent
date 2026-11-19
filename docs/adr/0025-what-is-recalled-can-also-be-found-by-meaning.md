# ADR 0025: What is recalled can also be found by meaning

- **Status:** accepted, 19 November 2026
- **Applies to:** `@xandreed/sdk/kernel` (the knowledge contract's recall: `recallKnowledge`'s list by meaning,
  `meaningTexts`, `meaningKey`, `checkedMeaningOptions`, `KNOWLEDGE_BY_MEANING`, `WORDS_WEIGHTS`,
  `MEANING_MODEL_LIMIT`, the event `plugin.knowledge.recalled`; the memory wrapper `withKnowledgeByMeaning`)
- **Takes up:** ADR 0023's first "What would reopen this" (recall by meaning beside the two lists, a third list,
  measured as those were) and ADR 0021's "Left for the next cut" (a recall wrapper over the two contracts), on the
  knowledge module
- **Leaves as they are:** ADR 0021 (the `Embedder` and `VectorStore` contracts, their kits, `recordedEmbedder`,
  `inMemoryVectors`) and ADR 0023 (`withKnowledge`, its two lists, its weights, the walk by subject, the note)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

ADR 0023 recalls what is kept with no model and no embedder: the memories about the entities a conversation names,
and those its last message's words reach by BM25, fused by rank, then a walk by subject. A question that names nobody
and shares no word with the memory it needs finds nothing: "Who keeps a bird?" cannot reach "Ana Silva has parrot
Pip.", since "bird" is not "parrot" to a comparison of letters. ADR 0021 drew the contracts that rank by meaning and
said vectors are an index of the journal; the wrapper written over them then (`withRecall`, over facts and links) was
removed with the graph. The knowledge module has no list by meaning.

Two things had to be settled: how a third list joins the two without changing them, and how much it weighs.

## Measured before deciding

Measured on 19 November 2026 through the kernel's own `recallKnowledge` (this record's code, with the list by meaning
given as what the store would find: the `pool` texts nearest the last message by cosine, among `meaningTexts`), over
the memory ADR 0023 measured on: 711 memories written by a script from the learn track's world, 395 entities. Eight
places and a walk of three, the 44 English stop words and the speaker's words of ADR 0023's measurement, the list by
meaning ranking 50 texts. Two embedders: e5-small-v2 (8-bit, local, each text embedded alone) and Gemini's
`gemini-embedding-001` at 768 dimensions, both from vectors cached by the earlier measurements (six Gemini texts were
missing and were embedded for this, for less than $0.0001).

The sets are ADR 0023's, a question found as it counted them (the memory it needs among those sent, or what it
replaced under one sent): 25 single questions, 14 that need two memories, 24 follow-ups, 39 asked after an unrelated
turn, 94 generated two-step questions; and two more: 10 questions that hold an exact identifier (an order number, a
licence plate, a thing bought, near-identical ones among them), and the 18 questions about what a curator kept from
ADR 0022's 40 turns (over that memory, 740 memories, 10 of them ended; found when a sentence sent says what it asks,
and the one about something forgotten when nothing sent says it). With the list by meaning off the kernel gives ADR
0023's counts, set by set (20, 8, 22, 24, 78; 16 of 18), so the rows below are this code's.

The list about a seed weighs 1 and the words' 0.5, as in ADR 0023; a place `p` (from 0) adds `weight / (10 + p)`.

| e5-small-v2 | single | two | follow-ups | unrelated | generated | identifier | curated | total of 224 |
|---|---|---|---|---|---|---|---|---|
| meaning off (`withKnowledge`) | 20 | 8 | 22 | 24 | 78 | 10 | 16 | 178 |
| meaning 0.5 | 23 | 8 | 22 | 29 | 78 | 10 | 16 | 186 |
| meaning 1 | 24 | 8 | 22 | 31 | 78 | 10 | 16 | 189 |
| **meaning 1.5** | **24** | **8** | **22** | **31** | **78** | **10** | **16** | **189** |

| Gemini | single | two | follow-ups | unrelated | generated | identifier | curated | total of 224 |
|---|---|---|---|---|---|---|---|---|
| meaning off (`withKnowledge`) | 20 | 8 | 22 | 24 | 78 | 10 | 16 | 178 |
| meaning 0.5 | 22 | 8 | 23 | 28 | 78 | 10 | 17 | 186 |
| meaning 1 | 24 | 9 | 23 | 32 | 78 | 10 | 17 | 193 |
| **meaning 1.5** | **24** | **9** | **23** | **33** | **78** | **10** | **17** | **194** |

The acceptance rows, over the lesson's world alone (its 557 memories), "Who keeps a bird?" and "Ana Silva has parrot
Pip.", which the list by meaning puts second (e5, cosine 0.782) or fifth (Gemini, 0.639):

| | e5, a fresh conversation | e5, straight after the Orchid question | Gemini, fresh | Gemini, after Orchid |
|---|---|---|---|---|
| meaning off | not sent | not sent | not sent | not sent |
| meaning 0.5 | sent (fused place 2) | not sent (15) | sent (5) | not sent (20) |
| meaning 1 | sent (2) | sent (4) | sent (5) | not sent (10) |
| **meaning 1.5** | **sent (2)** | **sent (2)** | **sent (5)** | **sent (5)** |

After the Orchid question ("Where does the person who leads Project Orchid live?", answered with João Reis's
memories), the bird question names nobody, so its seeds come from the turn before, and João Reis's memories fill the
list about a seed. A probe made while this cut was planned put the parrot at fused places 17, 5 and 2 for the three
weights; this code gives 15, 4 and 2: the probe placed the list by meaning one place lower (`w / (11 + p)`) and ranked
standing memories only.

- **1.5 is the only weight of the three that passes every acceptance row on both embedders.** At 1 the bird question
  straight after the Orchid question is not sent on Gemini (fused place 10); at 0.5 it is not sent after the Orchid
  question on either embedder. Among the weights that pass, 1.5 is also best or tied-best set by set on both: on e5
  it ties 1 in every set (189), on Gemini it is at least as high as 1 in every set (194 against 193). So no lower
  weight was left to prefer on a tie.
- **Above the grid**, run after the choice from the same caches: 2 found 190 on e5 (one more after an unrelated turn)
  and 194 on Gemini, no set lower than at 1.5; 3 found 191 and 194, but one follow-up fewer on e5. The weight was
  chosen among 0.5, 1 and 1.5, as planned, and is left there; a later measurement may move it to 2.
- **No question was lost** at 1.5 against the list off, on either embedder, in any set. What it gains: "Who suffers
  from seasickness?", "Who blocks out street noise at bedtime?", "These days, which racket sport does Carla Mendes
  play?" and "How did Bruno Reis get to work before he moved to Lisbon?" on both; on Gemini also "Is there any food I
  should avoid cooking for myself?" (the curated "can't stand coriander" ADR 0023 could not reach), a follow-up ("Do they
  have a pet?") and one that needs two memories. The rest of the 11 to 16 more is after an unrelated turn.
- **The pool.** At 1.5, ranking 20 texts found 189 (e5, one follow-up fewer and one unrelated question more) and 194
  (Gemini); 100 found 189 and 194: 50 is kept.
- **The identifier questions** were all found by words alone already, and stay found with the list on.

## Decision

- **`withKnowledge` stays as it is**: words only, no `Embedder`, its weights 1 and 0.5 (`WORDS_WEIGHTS`, the list by
  meaning at 0). A second wrapper, `withKnowledgeByMeaning(options)`, needs `Embedder`, `VectorStore` and `Sessions`.
  Its options are `withKnowledge`'s and `pool` (how many texts the list by meaning ranks, 1 to 100, 50) and `weights`
  (`{ seed?, words?, meaning? }`, each 0 to 10, 1, 0.5 and 1.5 unless given, at least one above 0), checked where
  written (`checkedMeaningOptions`, `KNOWLEDGE_BY_MEANING`).
- **A weight of 0 turns its list off.** The list is not made and adds nothing; with the list by meaning off nothing
  is embedded or searched, and the context is `withKnowledge`'s (a page with no embedder loaded can run the wrapper
  so). The walk by subject still starts from the three best memories about a seed whatever the seed list's weight:
  `walk: 0` turns it off.
- **The list by meaning ranks what the other two rank**: the standing memories and those ended as `changed` into
  one that stands (`meaningTexts`), an ended one taking its place for what replaced it, as in ADR 0023. A text found
  stands for every candidate that holds it, in the order the knowledge holds them.
- **The query is the last message alone**, embedded as a `query`; a memory's text is embedded as a `passage`. An
  empty last message embeds nothing.
- **Vectors are an index of the journal** (ADR 0021). Each text's vector is kept under `meaningKey(model, text)`: the
  embedder's model, a line feed and the text, never an id. A model's name is 1 to `MEANING_MODEL_LIMIT` (99)
  characters, so every key fits `KEY_LIMIT` whole; a longer one is refused where the layer is built. For each request
  the wrapper asks the store which keys it has, embeds what is missing as passages, 32 a call, puts each call's
  vectors, embeds the last message and searches among the keys of what can be ranked for `pool` of them. A store
  that was lost is filled again from the journal the same way; a host that ships vectors made ahead puts them under
  the same keys and embeds only the message.
- **`recallKnowledge` stays pure.** It is given what the store found (`ByMeaning`: the model, the pool, the weights
  and the texts with their cosines) and fuses the three lists; no model and no embedder is reached from the contract.
- **The event says it.** `plugin.knowledge.recalled` carries the weights, the model and the pool (`null` from
  `withKnowledge`), and each memory's place and cosine in the list by meaning, with the memory that took the place
  when one it replaced did (`via`), as for the other two lists. A live event, never stored: no journal changes.
- **The note does not change**: what the model reads is `knowledgeNote` of what is sent, whichever lists sent it.
- **An embedder that fails costs the list by meaning, not the request.** An `EmbedFailed` for a passage or for the
  message (a model in a page not loaded yet, a service down or refused by a spend cap) skips the list by meaning for
  that request: recall runs by the other lists as weighted, and `plugin.knowledge.recalled` says why in
  `meaning.skipped` (the failure's words, at most `SKIPPED_SHOWN`, 300, characters). A host's every turn does not fail
  with its embedder, and a page answers by words until its embedder is loaded, its options unchanged. A store that
  refuses (`VectorsRefused`) still fails the context as it is: a store that refuses is a host's mistake, not a medium
  that may come back; a store whose medium fails (`VectorsUnavailable`) is a defect, as its port says.
- **An optional floor, none by default.** `floor` (0 to 1) leaves out of the list by meaning every text whose cosine
  is under it. There is no default, because a floor is a number of one embedder's and on e5 no floor works (below).
  Top and eighth cosines over the lesson world's 557 standing memories, from the cached vectors:

  | message | e5 top | e5 8th | Gemini top | Gemini 8th |
  |---|---|---|---|---|
  | Who keeps a bird? | 0.785 | 0.761 | 0.654 | 0.587 |
  | Where does Ana Silva work now? | 0.849 | 0.789 | 0.855 | 0.774 |
  | Thanks! | 0.767 | 0.758 | 0.532 | 0.522 |
  | Hello | 0.768 | 0.754 | 0.560 | 0.549 |
  | What is the capital of France? | 0.784 | 0.769 | 0.604 | 0.558 |
  | Write me a haiku about rain. | 0.772 | 0.758 | 0.546 | 0.510 |
  | What time is it? | 0.769 | 0.759 | 0.534 | 0.509 |
  | Can you help me fix this bug in my code? | 0.780 | 0.763 | 0.560 | 0.543 |

  On e5 the messages that have no answer in the memory reach 0.767 to 0.784 at the top, as high as the bird question
  (0.785): any floor that keeps the parrot keeps them. On Gemini they reach 0.532 to 0.604 against the bird's 0.654: a
  floor near 0.62 would separate these, narrowly, on these eight messages. A host that measures its own embedder may
  set one.

## Rejected

- **Weights 0.5 and 1.** Lower on both embedders (0.5) or on Gemini (1), and neither sends the parrot after the
  Orchid question on Gemini (0.5 not on e5 either).
- **A default floor.** See "Decision": it does not carry between embedders, and on e5 none separates a greeting from
  the bird question.
- **The last message with the turn before as the query.** Not measured in this cut: the earlier spike measured the
  last message alone, and the turn before already seeds a follow-up through the list about a seed.
- **Changing `withKnowledge`.** A host without an embedder keeps ADR 0023's recall and type; the third list is a
  wrapper that asks for what it needs.
- **Vectors in the journal, or keyed by a memory's id.** ADR 0021's reasons: an index of one model, and ids of one
  journal.

## Consequences

- **Every message that is not blank is sent memories.** The list by meaning ranks something for any text, so a
  greeting is sent the `limit` memories nearest it, where `withKnowledge` sent none. A host that wants less lowers
  `limit` or the list's weight, or sets a floor its embedder's cosines support (none on e5).
- **Each request asks the store for every key** of what can be ranked, and embeds the message: one query, and
  passages only for what is new. The first request over a knowledge embeds all of it: at ADR 0021's measured 17.4 ms a
  text in batches of 32, about ten seconds for the lesson world's 557 memories in a page, unless the vectors are
  shipped.
- **The note is no longer**: the places are still `limit` and `walk`, whichever lists fill them.

What was not measured:

- No model answered from this note; these are counts of what is sent.
- The weight was chosen on the same sets it is scored on (there are no held-out sets for it), and the sets were
  written before the list by meaning existed. No weight between 1.5 and 2 was tried.
- e5 vectors were embedded one text at a time; a page that embeds in batches gets vectors a little different (ADR
  0021: a cosine of 0.9939 or more to each alone).
- A user with hundreds of memories of their own, another language, and a knowledge too large to hand the store every
  key for each search.
- The time a request takes with the list on, in a page or over a network.

## What would reopen this

- A held-out set on which another weight or pool is better on both embedders; the counts at 2 above already are, on
  these sets.
- An embedder whose cosines put unrelated memories first often enough that a floor is worth its number.
- A knowledge too large for `among` to hold every key, or for the first request to embed it all.
- The answers measured with a model, where the third list's places cost answers.

A change to this decision is a new record that supersedes this one; this one is not edited.
