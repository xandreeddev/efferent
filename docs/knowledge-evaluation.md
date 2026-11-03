# Evaluate native memory and retrieval

`scripts/knowledge-evaluation.ts` builds an `@xandreed/evals` application for
the native engine, full conversation context, transcript RAG, graph ablations,
and optional pinned reference deployments. The reference clients live only in
`scripts/knowledge-reference-clients.ts`; they are evaluation baselines and are
not published runtime adapters.

The repository's scripted tests establish protocol and implementation behavior.
They do not establish benchmark accuracy, provider reliability, or parity with
another memory engine. Those claims require configured models, deployments and
completed measurements on the same dataset split.

## Prepare the dataset

Download data separately and keep it outside tracked source. Do not send it to a
provider until that provider and its credentials are explicitly configured for
the evaluation.

- `normalizeLongMemEval(raw)` accepts the officially
  [cleaned LongMemEval release](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned).
  Pass the exact filename/version in the app configuration. It retains original
  session IDs, orders sessions by date, removes answer-location markers from
  inputs, and recognizes abstention cases by their `_abs` suffix.
- `normalizeLoCoMo(raw)` accepts the
  [LoCoMo JSON format](https://github.com/snap-research/locomo/tree/main/data).
  It creates one source per conversation session and maps dialogue evidence to
  its session. Original dialogue evidence remains in grader metadata. Therefore
  the built-in retrieval/citation scores measure **session-level** recall, not
  exact dialogue-level attribution. Category 5 is treated as abstention.

Neither normalizer copies answer labels into candidate input. References become
available to projectors and graders only after the candidate finishes. The app
fingerprints normalized cases and preserves the caller's dataset version.

## Create an application

An evaluation config exports the result of `knowledgeEvaluationApp`. Its host
supplies an answer model, the actual tokenizer, embedding calls, native services
and any optional semantic judge. The following is the composition shape; replace
the declared host bindings with your configured services:

```ts
import { readFile } from "node:fs/promises"
import { Context, Effect, Schema } from "effect"
import type { Scope } from "effect"
import type { LongTermMemory } from "@xandreed/core"
import type { EvaluationError } from "@xandreed/evals"
import {
  fullContextKnowledgeBackend,
  knowledgeEvaluationApp,
  nativeMemoryKnowledgeBackend,
  normalizeLongMemEval,
  transcriptRagKnowledgeBackend,
} from "./scripts/knowledge-evaluation.js"
import type {
  KnowledgeAnswerModel,
  KnowledgeModelSettings,
} from "./scripts/knowledge-evaluation.js"

declare const settings: KnowledgeModelSettings
declare const answer: KnowledgeAnswerModel
declare const countTokens: (text: string) => number
declare const embed: (
  texts: ReadonlyArray<string>,
) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EvaluationError>
declare const native: Effect.Effect<
  Context.Service.Shape<typeof LongTermMemory>, EvaluationError, Scope.Scope
>

const raw = await Effect.runPromise(Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Json),
)(await readFile("./datasets/longmemeval_s_cleaned.json", "utf8")))
const cases = await Effect.runPromise(normalizeLongMemEval(raw))
const manifest = {
  id: "native-graph", kind: "native" as const,
  engineVersion: "<framework-version>", protocolVersion: "native-extraction-1",
  configFingerprint: "<fingerprint-of-native-model-and-engine-settings>",
  extractionModel: settings.extractionModel,
  embeddingModel: settings.embeddingModel,
  embeddingVersion: settings.embeddingVersion,
  embeddingDimensions: settings.embeddingDimensions,
}

export default knowledgeEvaluationApp({
  dataset: "longmemeval-s-cleaned",
  datasetVersion: "<download-revision-or-content-sha256>",
  cases, settings, answer, countTokens,
  budget: { contextTokens: 8192, topK: 50, timeoutMs: 600000 },
  backends: [
    fullContextKnowledgeBackend(),
    transcriptRagKnowledgeBackend({
      space: {
        model: settings.embeddingModel, version: settings.embeddingVersion,
        dimensions: settings.embeddingDimensions,
      },
      embed, chunkChars: 1800, overlapChars: 200,
    }),
    nativeMemoryKnowledgeBackend({
      manifest, open: native, buildKey: "<shared-native-build-fingerprint>",
      graph: true,
    }),
    nativeMemoryKnowledgeBackend({
      manifest: { ...manifest, id: "native-no-graph" },
      open: native, buildKey: "<shared-native-build-fingerprint>", graph: false,
    }),
  ],
})
```

Create `native` from the real memory plugin and PostgreSQL storage with explicitly
configured extraction and embedding services. For this harness, configure its
namespace as `knowledge-evaluation`, collection as `memory`, and background
worker as false: the harness explicitly processes captured sources and verifies
their completion before querying. Configure source limits to fit the dataset;
an oversized session must be deliberately normalized/split, never silently
truncated. `utilityKnowledgeAnswerModel` adapts a host-provided `UtilityLlm` into
the structured answer contract. A host can instead provide its own
`KnowledgeAnswerModel` over `LanguageModel`.

Use the same persistent native store and `buildKey` for graph-on/off candidates
to reuse the exact extracted index. Candidate-local in-memory stores rebuild
independently and therefore do not isolate the graph's contribution from model
sampling. Report preparation separately: the first candidate may build the index
while the second reuses it. Retrieval and answer latency remain separate fields.
The disabled candidate passes `graph: false`, so traversal and graph-assisted
reranking are disabled. The enabled candidate reserves up to one quarter of
`topK` (at least one item) for relationship evidence before adding memory
records, then applies the same tokenizer budget. This context mixture is part
of its configuration fingerprint; it is not an unbudgeted extra context window.

For a consolidation ablation, build another native service with
`MemoryLive({ ...config, consolidate: false })` (or the corresponding memory
plugin option). Pass that service to a separate `nativeMemoryKnowledgeBackend`
with `consolidation: false`, a distinct candidate id, and a config fingerprint
and `buildKey` describing the disabled build. The enabled service uses
`consolidate: true` and declares `consolidation: true` (the default). Keep models,
graph retrieval, source ordering and budgets matched. Consolidation variants
always receive different index scopes; graph variants with identical extraction
configuration share one scope. The consolidation setting is host-declared and
must match the supplied service. Compare preparation cost separately from answer
quality, and do not infer consolidation quality from key-free protocol tests.

Run the ordinary evaluation CLI through the application entry:

```sh
env -u HTTP_PROXY -u HTTPS_PROXY bun scripts/knowledge-evaluation.ts run memory \
  --config ./knowledge.eval.config.ts --directory .artifacts/knowledge-evaluation
```

The existing evaluation CLI controls task/candidate selection, repetitions,
reports and optional exporters. A single application defaults to sequential
execution to avoid shared-index ablation races.

## Add reference baselines deliberately

`referenceKnowledgeBackend(deployment)` requires an explicit endpoint, engine
version, immutable container digest/source commit, configuration fingerprint,
extraction model, embedding model/version/dimensions, and time/poll limits.
Credentials are optional `Redacted` values and never enter candidate manifests.
The harness checks the declared extraction/embedding settings against the common
configuration. It does not independently attest a remote deployment's model
configuration; reports label model identity as host-declared.

The reference protocols are intentionally narrow and pinned:

| Reference | Ingest and readiness | Retrieval |
|---|---|---|
| Mem0 OSS REST | `POST /memories`; the synchronous OSS operation must return before the next source | `POST /search` scoped by a fresh evaluation `user_id` |
| Graphiti reference REST | `POST /messages` with supplied episode UUIDs; poll `/episodes/{group_id}` until those UUIDs are visible | `POST /search` scoped by that fresh group |
| Hindsight REST | Async retain with a caller UUID; poll retain completion, request consolidation and poll its returned operation | Bank-scoped recall, expanding observation source facts |

Graphiti's episode visibility is the completion boundary exposed by its reference
server, not a general durable-job guarantee. Pin and inspect the server version
used in an experiment. A worker failure that never makes the episodes visible
becomes a readiness timeout instead of a misleading empty retrieval result.
Hindsight observations whose source facts exceed its response budget can have
incomplete source attribution; the client does not invent missing citations.
Mem0's managed V3 API is a different protocol and is not used by this client.

Each reference trial uses a fresh isolated user/group/bank and cleans up only that
scope. Cleanup failures are logged. Configure the necessary deletion permission
for disposable evaluation data. Reference runtime packages, graph databases and
models are installed/run by the host; this script does not provision or modify
them. See [Mem0 OSS API](https://docs.mem0.ai/open-source/setup),
[Graphiti server](https://github.com/getzep/graphiti/tree/main/server), and
[Hindsight operations](https://hindsight.vectorize.io/developer/api/operations).

## Compare the evidence

All candidates use one answer model and prompt, one declared embedding space,
one supplied tokenizer, and a common evidence budget. The tokenizer counts the
rendered evidence including source identities. Records are selected whole;
full-context overflow becomes unavailable rather than quietly dropping history.
The shared prompt/question overhead is outside the evidence allowance.

The application records context/source fingerprints, candidate configuration,
engine/protocol/schema/prompt/model versions, build/retrieval/answer latency and
source-level retrieval/citation metrics. Separate graders report exact-answer
match, abstention correctness, retrieval recall/MRR, citation precision/recall,
and total monetary cost when every phase has cost telemetry. No citations on an
answerable case score zero. Missing relevance labels make retrieval unavailable.
Unknown model cost remains unavailable rather than zero; native hosts can supply
a phase usage meter to `nativeMemoryKnowledgeBackend`. That meter must return
usage since the previous read, not cumulative lifetime usage.

Semantic answer correctness requires an explicitly supplied judge with a pinned
model/version. Exact string match is a diagnostic and is not equivalent to the
official benchmarks' judged accuracy. Judge usage is not included in candidate
cost. The harness reports no benchmark accuracy claim until the configured run
has completed and its failures, unavailable measurements, split and model
settings have been reviewed.

Key-free checks:

```sh
env -u HTTP_PROXY -u HTTPS_PROXY bun test scripts/knowledge-evaluation.test.ts
```
