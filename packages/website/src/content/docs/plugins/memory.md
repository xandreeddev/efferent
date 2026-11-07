---
title: Long-term memory
description: Learn evidence-backed facts, preferences, decisions, and temporal relationships across conversations.
pluginId: "@xandreed/plugin-memory"
---

The native memory engine provides `LongTermMemory`. It turns captured sources
into reusable facts, preferences, decisions, recorded actions and supported
observations, with citations and a temporal knowledge graph. Use it when later
conversations should recall relevant earlier interactions.

It complements a window or summary conversation policy. It neither replaces
the session journal nor indexes workspace files automatically.

For a concrete explanation of extraction, graph construction and storage,
indexes, ranking scores and reranking, read
[how memory learns and retrieves](/docs/guides/memory-engine/).

## Install

```sh
npm install @xandreed/plugin-memory @xandreed/plugin-knowledge-postgres
```

Install the shared `effect`, core and SDK packages. Supply PostgreSQL/pgvector,
`UtilityLlm`, and Effect's `EmbeddingModel.EmbeddingModel`. The
[models plugin](/docs/plugins/models/) supplies the helper model, not embeddings.

## Add to an agent

```ts
import { knowledgePostgresPlugin } from "@xandreed/plugin-knowledge-postgres"
import { memoryPlugin } from "@xandreed/plugin-memory"

const plugins = [
  knowledgePostgresPlugin,
  { plugin: memoryPlugin, options: {
    namespace: "assistant",
    collection: "memory",
    embeddingModel: "host-embedding",
    embeddingVersion: "1",
    embeddingDimensions: 768,
    recallChars: 8_000,
    recallLimit: 8,
  } },
]
```

Use these entries in `Agent.define({ plugins })` alongside the remaining
loop, discovery, conversation-memory and session services. Configure the
database URL and supply an embedding service that actually produces the stated
768-dimensional space. Add [capture](/docs/plugins/memory-capture/) with the
same namespace and collection to learn from committed conversations.

## Evidence and time

Sources pass structured extraction and, by default, a review pass before
embedding and atomic publication. The review prompt shows the proposed
extraction in the output schema's wire form, an absent identity or validity
date as `null`, so a reviewer that keeps the proposal unchanged returns a
valid extraction and the job publishes. A memory or relation says why it
replaces others (`supersession`: `change` or `correction`) only when it
supersedes some; one that supersedes nothing may leave it `null` or out, and
one that supersedes records without it is dropped with a `RecordDropped`
note. Every memory is about the conversation's user, so the extraction prompt
asks that a memory never list the user in its `entities`, and that a relation
whose subject or object is the user define the user as an entity like any
other: a record that names a key the extraction does not define, an undefined
`user` among them, is dropped with a `RecordDropped` note ("The extraction
refers to an undefined entity key"). Facts and graph entities retain literal
source evidence. A quote that differs from the turn only in typography (curly
or straight quotes and apostrophes, a dash for a hyphen, a no-break space) is
anchored where it matches and stored as the turn's exact text, so a reply
written with typographic punctuation keeps its memories. Entity matching is conservative; ambiguous names can remain
separate. Model quality still determines whether an extracted claim is useful.

One extraction call reads at most `maxExtractionChars` of a source (48,000 by
default, the same as `maxSourceChars`, so a default source is one call). A
longer source is extracted window by window and the results are merged with
exact whole-source offsets before staging. Each helper call (extraction,
review, planning, reranking) runs with `CurrentKnowledgeHelperCall` set to its
purpose, scope, job and attempt where there is one, and the optional
`maxHelperOutputTokens`, so a host's `UtilityLlm` can budget or refuse it.
That cap is advisory: only a `UtilityLlm` that reads the reference applies
it, and the models plugin's own `UtilityLlmLive` does not.

The graph distinguishes when a fact holds in the world from when it became
known. Queries can specify `validAt` and `knownAt` independently. Changes and
corrections preserve historical beliefs; provenance and temporal filters apply
through graph traversal. Defaults allow two hops, with a maximum of three.

Explicit preferences need no repetition. Inferred routines require evidence
from at least three distinct source episodes. They remain observations and
never grant permission to perform an action. Handler success alone does not
prove that a real-world action succeeded.

## Retrieval and tools

The engine combines lexical and vector retrieval and graph expansion. Bounded
model-assisted query planning (`queryPlanning`) and evidence reranking
(`rerank`) are off by default: each adds one `UtilityLlm` call to every recall,
automatic turn context included, so enable one only when its quality is worth
that cost and latency. A failed or late helper call keeps the deterministic
retrieval. A turn-context section includes
relevant evidence and a small profile. It shares a retrieval deadline and is
recorded as turn context, outside the stable system prefix. Before recalling,
it catches up capture of the session's committed turns. `recallSection: "off"`
contributes no section and runs no catch-up: `memoryRecallNote` renders the
same text for a host that closes each step's request with it instead, or the
host leaves automatic recall out
([place memory recall yourself](/docs/concepts/native-knowledge/#place-memory-recall-yourself)).

Text and vector search contribute equally through reciprocal rank fusion;
their raw score magnitudes are not combined. With `queryPlanning`, each
query's two lists are ranked on their own and a memory's votes are summed
across them, so a memory a planned query finds first is not ranked behind
every match of the original question. Graph traversal adds a bounded
neighborhood separately. Graph assertions have no numeric importance or edge
weight. When enabled, the helper-model reranker can reorder or omit memory
candidates; it does not rerank the graph assertions themselves.

Recalled evidence is dated (`recallDates`, on by default): each record shows
the UTC date its source was said or written, a memory its kind and whether it
was stated or inferred, and a relation its validity, under one reading rule
([dated memory recall](/docs/concepts/native-knowledge/#dated-memory-recall)).
The labels add about 30 characters per record beyond `recallChars`, which
still bounds the records' text. A record's date never changes, so the recorded
section stays stable; `recallToday` (off by default) also says today's date
and marks relations that have ended, at the cost of text that changes daily.

When a later turn says something changed ("I switched to tea"), the new memory
supersedes the old one as a `change` and links it (`replaces`); the old one is
retired, never rewritten. Recall then shows the new memory as current and,
after the current records, the old one under "Earlier states, no longer
current:" as `previously: <text> (until <date>; replaced by <source>
revision <n>)`, so the model can answer what was true before without taking it
for what is true now
([earlier states in memory recall](/docs/concepts/native-knowledge/#earlier-states-in-memory-recall)).
`recallHistory` (default `"changes"`) chooses which earlier states: `"all"`
adds beliefs a `correction` found wrong, shown as `(corrected <date>; this was
wrong)`, and `"none"` shows none; `recall_memory` takes a `history` parameter
for one call. Earlier states take at most `recallHistoryShare` (default 0.2)
of `recallChars`, at most half of `recallLimit` of them, and only beside a
current record shown; a share they leave unused goes to current records.

A preference, routine, profile or fact said in several episodes (captured
turns, or remembered notes) ranks a little higher and says how often: recall
counts the distinct episodes among the sources whose own text states the
memory (its `mentions`, never the evidence of its entities), multiplies its
fused score by `1 + supportWeight × ln(min(episodes, 4))`, and labels it
`said <n> times, last <date>` from two episodes on. The default
`supportWeight` of 0.15 caps the boost at ×1.21, so repetition reorders
records of similar relevance and a strong match stays ahead of a weak one said
often; `0` turns it off
([memories said in several episodes](/docs/concepts/native-knowledge/#memories-said-in-several-episodes)).

A statement repeated in another conversation adds a mention to the memory it
restates instead of a second memory. The extraction names the candidate memory
a source restates (`restates`), and processing also recognises a new stated
memory with the kind and exactly the entities of an active one from another
source whose embedding is at least `restatementSimilarity` (default 0.92) alike;
`false` keeps only the restatements the extraction names. Memories without
entities never merge. The restated memory gains the source's spans and mention,
so it is said once more, and a later revision or forgetting of that source
takes them away again. A narrowed turn that admits the memory's own source
keeps it even when the restating source is outside its reach, without that
source's spans and mention
([one memory for a repeated statement](/docs/concepts/native-knowledge/#one-memory-for-a-repeated-statement)).
A restatement must have the same event time as the memory it restates.

A plan, goal or interest tied to a dated event holds only until the event.
The extraction gives such a memory the event's time (`eventAt`, resolved
against when the source was said), and once the event has passed a goal,
decision, action or preference is past: recall still returns it, labelled
`(event on <date>, past)`, but multiplies its fused score by `pastEventWeight`
(default 0.5) so a current record of similar relevance ranks above it, and the
profile leaves it out. A memory about an upcoming event reads `(event on
<date>)`. Facts, routines and profiles are never past, and nothing is deleted
for it. `recall_memory` takes a `temporal` parameter: `all` ranks past records
as any other for one call; `pastEventWeight: 1` turns the demotion off
([plans tied to a dated event](/docs/concepts/native-knowledge/#plans-tied-to-a-dated-event)).

Near-duplicates that publication kept apart are shown as one. After weighting,
a memory of the same kind and event time as a memory ranked above it, whose
embedding is at least `recallCollapseSimilarity` (default 0.95) alike, is
folded into it: it gives up its place among the `recallLimit` and its share of
`recallChars` to other evidence, and the kept memory lists it in `alike`, cites
its sources and counts its episodes, so four wordings of one fact read as one
line `said 4 times`. Passages never fold, nothing is merged in the store, and
`false` turns folding off. `recallMinSimilarity` (absent by default) sets a
floor on semantic search: memories whose embedding is less similar to the
question than that are not found by meaning, only by their words; measure
your embedding model before setting one
([near-duplicates and a similarity floor](/docs/concepts/native-knowledge/#near-duplicates-and-a-similarity-floor)).

Automatic context also prepends up to four active preference/profile records
whose dated event, if any, has not passed, independently of the question's
search ranking: the profile's first four within the run's reach, ordered by
how many episodes said each, then by when it was last said, then by id, never
by the store's order, each with its count (a record recall folded into another
is shown once, as the profile's record)
([the profile's order](/docs/concepts/native-knowledge/#the-profiles-order)). See the
[worked retrieval example](/docs/guides/memory-engine/#5-find-memories-for-a-new-question)
for the scores, graph expansion and final prompt path.

Read tools are `recall_memory` and `read_memory`. The separate management skill
exposes `remember_memory` and `forget_memory` under the `memory.write` grant.
A `recall` result's `sources` give the times and metadata of each source
revision it cites. `renderMemoryRecall` and `memorySourcePage`, the text those
tools show, are exported for a host's own tools
([cited sources](/docs/concepts/native-knowledge/#cited-sources-and-evidence-text)).
Model-facing scope comes from the current session's owner, unless the host
narrows it per turn with `KnowledgeNarrowing`: another owner and, optionally,
the only sources recall, reads and the turn-context section may reach, by id,
by their metadata or both, its profile records included (see
[narrow retrieval per turn](/docs/concepts/native-knowledge/#narrow-retrieval-per-turn)
and [narrow by source metadata](/docs/concepts/native-knowledge/#narrow-by-source-metadata)).
A memory matches a metadata filter only when every source revision of its own
evidence does (later restatements aside), and the store applies the filter before its candidate limit. Narrowing
scopes reads only: saving, forgetting and conversation capture keep the session
owner, and a source outside the listed ones cannot be forgotten (it is not
found). Forgetting removes every revision of a source, so while a metadata
filter is set no source can be forgotten: `forget_memory` answers each as not
found. What conversation capture stores of each committed turn is the host's to
screen with `MemoryCaptureAdmission`: admit it, admit replacement text, or
refuse it, so it is never recalled (see
[screen turns before capture](/docs/plugins/memory-capture/#screen-turns-before-capture)).
The catch-up the recall section runs before recalling asks it too. Host APIs
explicitly name owner, namespace and collection, and `recall` takes a `sources`
filter and a `metadata` filter.

## Processing, persistence and forgetting

Capture returning a job means durable acceptance, not completed learning.
The runtime worker processes it asynchronously. Inspect `status`, use `retry`,
or set `worker: false` and schedule bounded `process(scope, limit)` calls.
Model or embedding failures publish no partial knowledge; valid staged
extraction can survive retry. One extracted record that fails a check of its
own (an invalid span, an undefined entity key, an unknown record it
supersedes, records it supersedes without a `supersession`, …) is left out with a `RecordDropped` note on the job's stage
(`status`), and the rest of the turn's knowledge publishes; the job fails with
`Invalid` only when no memory or relation survives (entities alone do not
count) or the extraction repeats an entity key. A change stated without a date ("I moved to Oslo") is dated at the
captured turn's time, with `validFromBasis: "observed"` (see
[graph, time and evidence](/docs/concepts/native-knowledge/#graph-time-and-evidence)).
Shutdown stops new claims and bounds active work.

Captured jobs are recorded under an engine id derived from the extraction
version and the embedding options
(`knowledgeEngineId("memory:8", { model, version, dimensions })`, version 8
since the prompt says how to refer to the conversation's user, version 7
since a `supersession` is asked for only from a record that supersedes, version 6
since the review's wire-form proposal, version 5 since event times, version 4 since restatements, version 3 since memory supersessions and successor links,
version 2 since dropped records and observed dates). The worker and `process` discover
and claim only jobs of that id, so engines configured with different embedding
spaces on one store never learn from each other's sources, and a job queued
under the earlier extraction version waits for a worker of that version. After changing the embedding options, capture the source again
as its next revision to process it under the new configuration.

`retry` starts a failed job over: it requeues the job under the engine's
current id with its attempts reset, so the job gets `maxAttempts` again, and a
job that failed under the engine's earlier embedding options is taken over by
the reconfigured engine; a scope outside the engine's namespace and
collection is refused. To find failed jobs without keeping their ids, page
through `MemoryStore.failed({ namespace, collection, reasons, limit, after })`,
which lists them across owners with the reason each failed with, and `retry`
those worth retrying (`isRetryableKnowledgeFailure(job.phase)`, or the
reasons a configuration change can fix). A failed extraction's phase also says
where and how it failed, without its content (`diagnostic`, a
`KnowledgeFailureDiagnostic`): the `stage` (`extract`, `review` or `stage`),
for a reply that did not decode the `path` of its first decode issue (empty for
the reply as a whole), the `finishReason` and `outputTokens` the helper
completion reported and the `window` it read. A reply cut off at the output cap
reads `finishReason: "length"` with an empty path, which raising the helper's
output cap or lowering `maxExtractionChars` fixes; a schema drift names the
field that broke it; a staging refusal holds the stage alone. The engine sets
the same facts on the span that processed the job
(`efferent.knowledge.failure.*`, `knowledgeFailureAttributes`). A job whose review failed under
version 5 by copying that version's proposal back (`Invalid`, "The
extraction model returned an invalid knowledge object") is one: `retry`
requeues it under the current id through `KnowledgeIndex.requeue`. So is a job
that failed under version 6 with the same message because a record that
supersedes nothing gave a `null` or no `supersession`, which version 7
accepts, and a job that failed under version 7 with `Invalid` ("The extraction
refers to an undefined entity key") because every record it proposed named
the user without defining it. A completed job keeps what it published, its
dropped records' notes included; `retry` does not extract it again.

`forget` tombstones a source and removes its text and dependent learned
knowledge, including historical graph evidence. Backfill cannot resurrect that
source. Original session journals and database backups require their own
retention policy. See [capture](/docs/plugins/memory-capture/),
[RAG](/docs/plugins/rag/) for documents, and
[context and the journal](/docs/concepts/context-journal/) for the full data path.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-memory` · Version **0.18.0** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `@xandreed/core/LongTermMemory` |
| Requires | `@xandreed/core/MemoryStore`, `@xandreed/core/UtilityLlm`, `effect/ai/EmbeddingModel` |
| Uses when available | none |
| Contributes | `efferent/Capabilities`, `@xandreed/core/BackgroundWorkers` |

### Default options

```json
{
  "namespace": "default",
  "collection": "memory",
  "embeddingModel": "host",
  "embeddingVersion": "1",
  "embeddingDimensions": 1536,
  "review": true,
  "consolidate": true,
  "queryPlanning": false,
  "rerank": false,
  "retrievalTimeoutMs": 10000,
  "worker": true,
  "pollMs": 2000,
  "batchSize": 10,
  "maxAttempts": 3,
  "leaseMs": 180000,
  "modelTimeoutMs": 60000,
  "maxSourceChars": 48000,
  "maxExtractionChars": 48000,
  "maxCandidateChars": 32000,
  "recallChars": 8000,
  "recallLimit": 8,
  "graphDepth": 2,
  "recallSection": "turn",
  "sectionOrder": 700,
  "tools": true,
  "recallDates": true,
  "recallToday": false,
  "recallHistory": "changes",
  "recallHistoryShare": 0.2,
  "supportWeight": 0.15,
  "restatementSimilarity": 0.92,
  "pastEventWeight": 0.5,
  "recallCollapseSimilarity": 0.95
}
```

### Options schema

<details>
<summary>Show the full configuration schema</summary>

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "properties": {
    "namespace": {
      "type": "string",
      "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      "minLength": 1
    },
    "collection": {
      "type": "string",
      "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      "minLength": 1
    },
    "embeddingModel": {
      "type": "string",
      "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      "minLength": 1
    },
    "embeddingVersion": {
      "type": "string",
      "pattern": "^\\S[\\s\\S]*\\S$|^\\S$|^$",
      "minLength": 1
    },
    "embeddingDimensions": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "review": {
      "type": "boolean"
    },
    "consolidate": {
      "type": "boolean"
    },
    "queryPlanning": {
      "type": "boolean"
    },
    "rerank": {
      "type": "boolean"
    },
    "retrievalTimeoutMs": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "worker": {
      "type": "boolean"
    },
    "pollMs": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "batchSize": {
      "type": "integer",
      "maximum": 100,
      "exclusiveMinimum": 0
    },
    "maxAttempts": {
      "type": "integer",
      "maximum": 10,
      "exclusiveMinimum": 0
    },
    "leaseMs": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "modelTimeoutMs": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "maxSourceChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "maxExtractionChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "minimum": 1000
    },
    "maxHelperOutputTokens": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "maxCandidateChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "recallChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "recallLimit": {
      "type": "integer",
      "maximum": 100,
      "exclusiveMinimum": 0
    },
    "graphDepth": {
      "type": "integer",
      "maximum": 3,
      "exclusiveMinimum": 0
    },
    "recallSection": {
      "type": "string",
      "enum": [
        "turn",
        "off"
      ]
    },
    "sectionOrder": {
      "type": "integer",
      "minimum": -9007199254740991,
      "maximum": 9007199254740991
    },
    "tools": {
      "type": "boolean"
    },
    "recallDates": {
      "type": "boolean"
    },
    "recallToday": {
      "type": "boolean"
    },
    "recallHistory": {
      "type": "string",
      "enum": [
        "changes",
        "all",
        "none"
      ]
    },
    "recallHistoryShare": {
      "type": "number",
      "minimum": 0,
      "maximum": 0.5
    },
    "supportWeight": {
      "type": "number",
      "minimum": 0,
      "maximum": 1
    },
    "restatementSimilarity": {
      "anyOf": [
        {
          "type": "boolean",
          "enum": [
            false
          ]
        },
        {
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 1
        }
      ]
    },
    "pastEventWeight": {
      "type": "number",
      "minimum": 0,
      "maximum": 1
    },
    "recallMinSimilarity": {
      "type": "number",
      "minimum": -1,
      "maximum": 1
    },
    "recallCollapseSimilarity": {
      "anyOf": [
        {
          "type": "boolean",
          "enum": [
            false
          ]
        },
        {
          "type": "number",
          "exclusiveMinimum": 0,
          "maximum": 1
        }
      ]
    }
  },
  "required": [
    "namespace",
    "collection",
    "embeddingModel",
    "embeddingVersion",
    "embeddingDimensions",
    "review",
    "consolidate",
    "queryPlanning",
    "rerank",
    "retrievalTimeoutMs",
    "worker",
    "pollMs",
    "batchSize",
    "maxAttempts",
    "leaseMs",
    "modelTimeoutMs",
    "maxSourceChars",
    "maxExtractionChars",
    "maxCandidateChars",
    "recallChars",
    "recallLimit",
    "graphDepth",
    "recallSection",
    "sectionOrder",
    "tools",
    "recallDates",
    "recallToday",
    "recallHistory",
    "recallHistoryShare",
    "supportWeight",
    "restatementSimilarity",
    "pastEventWeight",
    "recallCollapseSimilarity"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
