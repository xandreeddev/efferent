# ADR 0021: What is recalled by meaning is an index of the journal

- **Status:** accepted, 18 November 2026
- **Applies to:** `@xandreed/sdk/kernel` (the `Embedder` and `VectorStore` contracts, their kits
  `embedderConformance` and `vectorStoreConformance`, `recordedEmbedder`, `inMemoryVectors`)
- **Takes up:** the part ADR 0014 left out ("an `Embedder` contract, and a wrapper over it") and ADR 0019's
  "What would reopen this"
- **Amends:** skill `kernel-architecture`'s "Do not add" list (an index of the journal is not a store beside it)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

What an agent knows is a journal of its own: facts (ADR 0014) and links between things (ADR 0019), ranked for a
question by the words it shares with them. A question that says "employs" finds no link that says "works at", and a
fact that holds none of the question's words is never sent. Ranking by meaning needs each text turned into numbers
by a model, an embedder, and the numbers closest to the question's found among many.

ADR 0014 left an `Embedder` out, and ADR 0019 measured why: a small embedding model scored Lisbon nearer Paris than
Lisboa, so names are not merged by meaning. Ranking is another use: finding the stored sentences a question is
about, not deciding that two names are one thing. Read literally, a store of vectors is "a store beside the
journal", which the kernel's skill forbids (ADR 0003). The line has to be drawn before the first one is written.

Measured for lesson 20 on the English `e5-small-v2` (8-bit), in a page, on one thread: 34.2 MB of model files,
loaded in 3.1 s cold and 1.1 s warm, 30 ms for one text, 17.4 ms a text in a batch of 32 and 14.8 in one of 700.
Over the free-text facts written for lesson 20, nine pairs of sayings of one claim sat at a cosine of 0.881 to 0.927
(median 0.913), and five pairs of a claim and one that contradicts it at 0.883 to 0.922 (median 0.913): an embedder cannot tell a claim said again
from one said otherwise. In a batch of 32, the 8-bit model gave each text a vector at cosine 0.9939 to 1 of the one it
gives alone (96 texts; at full precision, 1): it scales its numbers for each batch, so the kit asks for 0.99.

## Decision

- **Two contracts, each with a kit.**
  - `Embedder`: `model`, the name of what makes the vectors, and `embed(texts, as)`, one vector per text, in
    order, all of one length, as a question (`query`) or as a text kept to be found (`passage`), since many models
    (e5 among them) embed the two differently. A text it cannot embed, or a model or service that fails, fails the
    call with `EmbedFailed`, in words. `embedderConformance` checks `order`, `same`, `dimension`, `empty` and
    `both` over texts the subject gives, so a recorded embedder and a model pass the same kit.
  - `VectorStore`: `put(entries)` (a key put again is replaced; a put is whole or nothing), `search(vector, {
    limit, among? })` by cosine, best first, ties by key, `among` the only keys that may be found and the limit
    still filled, and `has(keys)`, so a caller embeds only what is missing. A vector of another length than the
    store's, numbers that are no vector, a key that is no key and a limit that is none are refused
    (`VectorsRefused`, a reason and words). A medium that fails is `VectorsUnavailable`, a defect of the caller's
    call, as `FilesUnavailable` is (ADR 0017). `vectorStoreConformance` checks `replace`, `order`, `ties`,
    `limit`, `among`, `has`, `dimension` and `empty`.
- **Vectors are an index of the journal, never a store of truth.** What is embedded is what the journal holds (a
  link's sentence, a fact's text); the store keeps it under a key the caller makes from the text, and the caller
  reads the item itself from the journal. Lost, the store is made again from the journal: nothing is in it that the
  journal does not hold. It is not a store beside the journal in the skill's sense, because no part rebuilds itself
  from it: the agent's state, its facts, links and grants are what the journal's folds give, with or without it.
- **The index is keyed by the embedder's model and the text embedded**, never by an id: ids belong to one journal
  (lesson 18's world stores the same sentence as `e10` on one page and `e1` on a fresh one), so a key made from an id
  would miss vectors made ahead, or find another sentence's. The caller makes each key from `Embedder.model` and the
  text, so a vector is compared only with vectors its own model made: with another model, `has`
  finds none of its keys, and the items are embedded again, from the journal, never mixed. A store keeps vectors of
  one length (its first's), so a model whose vectors are of another length is refused by `put` and needs a fresh
  store.
- **What is standing is the journal's, not the store's.** A link removed or a fact forgotten may keep its vector,
  and so may an item another model embedded; a search is given `among`, the keys of the items that stand under the
  present model, so neither is ever found, and the limit is still filled from those
  that stand.
- **Counting and folding are no embedder's job.** Since a claim said again and one said otherwise sit at the same
  likeness, how often a thing was said is counted by the records (`plugin.graph.restated`, ADR 0019), never by
  vectors that are alike.
- **Local and remote embedders, an in-memory store and later a database.** A host provides each: a model in the
  page or the process, a service over an OpenAI-compatible `/v1/embeddings`, a store in memory, Postgres with
  pgvector. The kernel ships `recordedEmbedder`, which answers recorded texts and refuses any other in words (for
  tests, and a page that shows recall without a model), and `inMemoryVectors`. No kernel plugin calls a model.

## Consequences

- An index is rebuilt by embedding again what the journal holds; in a page that can take seconds for a world of
  hundreds of sentences, so a host may ship vectors made ahead by the same model and embed only what is new.
- A store of vectors does not branch with a session (ADR 0016): it is keyed by items, and `among` keeps a search to
  the items a journal holds.
- A test or a lesson can show ranking by meaning with no model: recorded vectors, checked by the same kit.

## Left for the next cut

- The recall wrapper: embedding what the store lacks, the question's vector, the search among what stands, and the
  note added last for a request, as `withFacts` and `withGraph` add theirs (ADR 0005).
- The note's words, and the live event that says what was found and with what score, as `plugin.graph.recalled` does.
- An embedder that fails then fails the context in words, never a request sent as though nothing were known.

## Rejected

- **Vectors in the journal** (each embedding a record): numbers of one model kept for good, every journal a copy of
  them, and a model changed would leave them all wrong.
- **One `Recall` contract** over embedding and storing: a host replaces the model and the store separately, a page
  and a database each in its own way.
- **Merging names, or counting claims, by likeness**: ADR 0019's measurement for names, this record's for claims.

## What would reopen this

- A part other than a recall wrapper that must read the store to build the agent's state.
- An index too large to make again from the journal in the time a host has.
- A model whose vectors of one text change between calls.
- A store too large to be given every standing key as `among` for each search, or one whose vectors of removed items
  must be deleted: the contract has no delete, since an index of the journal may keep what the journal no longer
  stands by.

A change to this decision is a new record that supersedes this one; this one is not edited.
