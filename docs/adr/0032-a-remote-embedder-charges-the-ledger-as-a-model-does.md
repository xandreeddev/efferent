# ADR 0032: A remote embedder charges the ledger as a model does

- **Status:** accepted, 19 November 2026
- **Applies to:** `@xandreed/sdk/kernel/node` (new: `openAiCompatibleEmbedder`, `OpenAiCompatibleEmbedderOptions`,
  `EmbedPrefixes`, `EMBEDDER_NAME_LIMIT`; `spendRefusalOf` and `isSpendRefusal` also read an `EmbedFailed`)
- **Amends:** ADR 0026 (the charge holds a call with an output bound of 0; a refusal also rides in an `EmbedFailed`'s
  `cause`), ADR 0021 (what `EmbedAs` means on a model that reads no prefix of its own), ADR 0030 (the charge's
  metrics carry `gen_ai.operation.name`; the span `openai_compatible_embedder.embed`)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

The old engine and every `plugin-*` package are removed before the next release. The kernel has the `Embedder`
contract (ADR 0021), its kit and `recordedEmbedder`; the learn track's page runs e5 in a worker. A host on Node or
Bun had no embedder: nothing that turns a conversation's texts into vectors through a provider, charged to the
ledger its model calls charge. Five things had to be decided: which wire, what `EmbedAs` means on a model that reads
no prefix, what names the vectors, how a call is charged and refused, and what a call shows a tracer.

## Decision

### One adapter over the OpenAI-compatible `/embeddings` wire, on the Node entry

`openAiCompatibleEmbedder(options)` is a `Layer<Embedder, never, ModelSpend>` in its own folder of the Node entry
(`embedder-openai-compatible/`, the layer `sdk-kernel-node-embedder-openai-compatible`), beside the model providers
(ADR 0026) and for their reason: a key in a page is readable by every script on it. It imports the contract it
implements and the charge the providers share (`model-spend/`), never a provider's folder, and sends over `fetch`
(`FetchHttpClient`). One wire serves OpenAI, the Vercel AI Gateway (Gemini's and OpenAI's models among others) and a
local server: `POST <baseUrl>/embeddings` with `model`, `input` (the texts) and, when the options name it,
`dimensions`; the answer's `data` holds a vector per text by its `index`, and `usage` its tokens (and, on a gateway
that says, `cost`). No encoding is asked for: the wire's default is a list of numbers. Options:
`{ model, baseUrl, apiKey?: Redacted, dimensions?, batch?, prefixes?, name?, timeouts?, spend, provider? }`.

- **Batches.** Texts go in requests of at most `batch` (64 by default, what Gemini's embeddings took through the
  gateway), one after another: each is a call of its own, charged and counted on its own, so a 4xx on the third
  request releases that request's hold and not those of the two the provider already billed. No texts send nothing
  and hold nothing (the kit's `empty`).
- **Vectors are made unit length**, every one: Gemini's vectors cut to fewer dimensions are not, OpenAI's are, and
  dividing a unit vector by its length leaves it as it was. A vector of zeros points nowhere and fails the call, as do
  a vector missing or given twice, numbers that are no vector, two lengths in one call, and a length other than the
  `dimensions` asked for: the name promises that length.
- **Timeouts.** `timeouts.response` bounds the wait for the headers, as the providers' does (`reaching`); the body is
  read whole, so `timeouts.idle` bounds that read (a body that does not come whole in time is a lost connection, settled
  at the hold); a refusal whose body cannot be read in time is the provider's refusal by its status alone.

### `EmbedAs` means something on every model: prefixes

e5 reads `query: ` before a question and `passage: ` before a kept text; OpenAI's and Gemini's embedding models read
no prefix. `prefixes: { query?, passage? }` is the text put before each text as it is sent, none by default, so a
host gives e5's and leaves the others'. A model that tells the two apart some other way (Gemini's task types, through
a body field) is left to a later cut: the gateway's field for it is not the same on every route.

### Its name keys the vectors, so it carries what decides them

`Embedder.model` is what a caller keys vectors with (ADR 0021). Two configurations of one model, another `dimensions`
or other prefixes, make vectors that must never answer each other's queries, so the default name is made of all three
(`embedderNameOf`): the model, ` dimensions=<n>` when given, ` prefixes=["<query>","<passage>"]` when either is given,
JSON-quoted so that no two configurations make one name (`google/gemini-embedding-001 dimensions=768`). Empty prefixes
are none: the same vectors, the same name. A host may give its own `name` and promises it differs from every other
configuration's. Three strings stay apart: the wire's `model` is what is sent, what keys `spend.prices` and what the
metrics name (`efferent.model`); the name keys vectors only.

A vector's key is the name, a line feed and a text of up to 300 characters within the vector store's 400, so the name
is 1 to `EMBEDDER_NAME_LIMIT` (99) characters with no line break. Options that make no name, or a `batch` or
`dimensions` that is no count, die where the layer is built, as `processShell`'s do. A name over the limit is not cut
or hashed: two cut names can collide, and the host is asked for a `name` of its own.

### It charges the ledger through the providers' charge

Each request is `chargedEffect` (ADR 0026) with the shared rules, and nothing new but the bound: an embedding has no
output, so its call is charged with an **output bound of 0**, and an embedding model's price has `output: 0`.
`chargeOf` already took a bound of 0 as a bound (a table row now says so); only a missing bound is refused.

- **The worst case** is the request body's bytes as input tokens (`bytesPerToken`, 1 by default) at the dearest input
  price, as for a model. The texts' own bytes would be tighter, but a tokenizer may add tokens of its own to each text
  (e5 adds two), and at `bytesPerToken` 1 the body's quotes and comma around each text cover them; a host that raises
  `bytesPerToken` takes that margin on. One rule for both kinds of call keeps the charge the providers'.
- **Settled** at what the provider billed (`usage.cost`, a number or text), else its reported input tokens at the
  price, else at the hold once the request left; a refusal status (4xx but 408) and a connection that never opened
  release. The usage is reported to the charge before the vectors are checked, so an answer whose vectors are refused
  is still settled at what it cost.
- **Failures are `EmbedFailed` in words** (the contract's `message` and `cause`): a refusal of the ledger keeps the
  ledger's `ModelSpendExceeded` as its `cause`; any other failure keeps an `AiError` whose reason says whether another
  try is worth it (429, 408, 5xx, a lost connection, an answer that is no list of embeddings are; 401, 402, 403, 400, a
  model with no price and a ledger's refusal are not). `spendRefusalOf` reads the refusal from an `EmbedFailed`'s
  `cause` as it reads it from an `AiError`'s reason (by tag, the cause decoded as the ledger's refusal), so
  `isSpendRefusal` tells a budget's refusal from every other failure of either; an eval run's account sees the refusal
  at the ledger as for a model call. The `AiError` stays the cause rather than becoming the failure: the contract's
  failure is `EmbedFailed`, and a caller that only embeds never matches a model's error.

### What a tracer sees

Each `embed` is the span `openai_compatible_embedder.embed` (ADR 0030's `<part>.<op>`), of kind `client`, with
OpenTelemetry's keys for an embeddings call: `gen_ai.operation.name` `embeddings`, `gen_ai.provider.name` (`openai`
unless `provider` names another), `gen_ai.request.model`, `gen_ai.embeddings.dimension.count` when asked, and
`gen_ai.usage.input_tokens`, the tokens its requests reported, summed, set however the call ends. Each request's
`POST` is Effect's own span under it. No text it embeds is put on a span. The charge counts each request as a model
call: `efferent.model.calls` by how it ended, `efferent.model.tokens` (`input`, and an `output` of 0), and
`efferent.model.cost` with its basis. With embeddings among them, a series by model alone would mix two kinds of
call before the names freeze at the release, so all three metrics now also carry `gen_ai.operation.name`, set by the
charge from what each provider gives it (`Charging.operation`): `chat` for `openAiCompatibleModel` and
`anthropicModel`, `embeddings` for the embedder. OpenTelemetry's key is kept because it names the same thing (ADR
0030's rule), and it is the key its own `gen_ai.client.*` metrics are split by. A failure's words can echo the texts (a provider that refuses a request can
repeat it): with the export's `content` off, the span's exit reaches the exporter as the failure's type alone
(`withheldExit`), as for a model call; a test plants markers in the texts, the key and a refusal that echoes the
request, and finds none posted, and finds the echoed words posted with `content` on.

### The real call recorded for this cut

Through the gateway on 19 November 2026, three texts each ("Ana Silva lives in Porto.", "Ana Silva moved to Braga in
October 2026.", "Carla Mendes likes green tea."), as passages:

| Model | Name | Length | Porto~Braga | Porto~tea | Braga~tea | Settled |
|---|---|---|---|---|---|---|
| `google/gemini-embedding-001` | `google/gemini-embedding-001 dimensions=768` | 768 | 0.8314 | 0.5987 | 0.5897 | $0.00000375 (usage) |
| `openai/text-embedding-3-small` | `openai/text-embedding-3-small` | 1536 | 0.7120 | 0.3458 | 0.2611 | $0.00000052 (usage) |

Every vector came back of length 1 after the cut. The gateway's embeddings answer gave its tokens and no `cost`, so
each call settled at its usage at the gateway's listed price (0.15 and 0.02 USD a million input tokens), which was
what the account was charged.

## Consequences

- A Node or Bun host ranks by meaning through OpenAI, the gateway or a local server without the old engine, each
  request charged to the ledger its model calls charge; an eval run's budget caps its embeddings too.
- A host that changes an embedder's dimensions or prefixes gets a new name, so its stored vectors are embedded again
  rather than compared across configurations; a host that names its embedder itself takes that on.
- `spendRefusalOf` now reads two shapes: the `AiError` a provider fails with and the `EmbedFailed` an embedder fails
  with. A third kind of charged call would add its own.
- The status-to-reason table of a refused request is written in the embedder's folder too, beside the chat wire's:
  each folder imports the charge alone, never another port's folder (ADR 0024's layers).

## Left open

- Gemini's task types and OpenAI's `user`, sent as body fields (the chat provider's `extra`): no host needs them yet.
- Base64 vectors (`encoding_format`), which would halve a large answer's bytes.
- Requests sent at once rather than one after another: a host with thousands of texts would want a bounded number at
  a time, and a provider's rate limit decides how many.

## What would reopen this

- A provider whose embedding call bills output, or bills a refused request.
- A vector store that keys by something other than the name and the text.
- An embedding model that reads a question and a passage the same way but must be told which by a field: `EmbedAs`
  would map to that field instead of a prefix.
