# ADR 0026: A model provider charges the ledger it is given

- **Status:** accepted, 19 November 2026
- **Applies to:** `@xandreed/sdk/kernel/node` (new: `openAiCompatibleModel`, `OpenAiCompatibleOptions`,
  `anthropicModel`, `AnthropicOptions`, `ModelPrice`, `SpendOptions`, `Timeouts`, `isSpendRefusal`,
  `spendRefusalOf`)
- **Amends:** ADR 0020 (a first-party provider now charges the ledger; the eval run's budget caps what it sends),
  ADR 0024 (two ports join the Node entry, and a folder both share, as the stores share the lock)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

The old engine is deleted before the next release, and its models plugin is how a Node host reaches OpenAI, Gemini,
the Vercel AI Gateway and Anthropic today, charging old core's spend ledger. The kernel had no provider: a host built
Effect AI's `LanguageModel` itself, and nothing first-party charged the kernel's `ModelSpend` (ADR 0020), so an eval
run's `--budget-usd` capped nothing a first-party provider sent. Five things had to be decided: which wire each
provider speaks, where the charge sits, what a call holds and what it is settled at, what is worth another try, and
which entry the providers belong on.

## Decision

### Two providers, each a layer that needs the ledger

- **`openAiCompatibleModel(options)`** is one adapter for OpenAI, Gemini's OpenAI-compatible endpoint and the Vercel
  AI Gateway: chat completions, streamed, with tool calls. They differ by their address (`baseUrl`), their key
  (`apiKey`, `Redacted`, read from `Config` by the host), the field the output cap is sent in (`outputField`:
  `max_tokens`, or `max_completion_tokens` for OpenAI's reasoning models) and the fields a host adds to the body as
  given, opaque (`extra`: the gateway's `providerOptions`, a `prompt_cache_key`); a field a request is made of is
  refused, never replaced.
- **It speaks the wire itself, not `@effect/ai-openai`.** That package's language model posts to OpenAI's Responses
  API (`/responses`) alone, which Gemini's OpenAI-compatible endpoint does not serve. The wire is the learn track's
  gateway wire, the shapes read from DeepSeek V4.1 Flash on Baseten through the gateway, written again under the
  sdk's rules (`chat-wire.entity.ts` and its functions; the website keeps its copy, which a page imports). So
  `@effect/ai-openai` is not a dependency of the sdk: only `@effect/ai-anthropic` is.
- **`anthropicModel(options)`** is Effect AI's Anthropic provider (`@effect/ai-anthropic`): streaming, tool calls,
  the provider's errors mapped by its client. Prompt caching marks the request with the API's own
  top-level `cache_control` (`cache`: `5m` by default, `1h`, `off`), so the provider caches the prefix up to the last
  block it can and the next request of the conversation reads it back. The old plugin's placement of its own marks
  on chosen blocks, its per-model thinking settings, its beta headers and its subscription sign-in are not ported.
- Each is a `Layer<LanguageModel, never, ModelSpend>`: a stack with no ledger does not compile (ADR 0020). The
  ledger is the one in context when the layer is built, and every call of that layer charges it: an eval host that
  gives each trial an account builds the provider's layer under the trial's account, or the trial's accounting sees
  none of its calls. It sends
  over `fetch` (`effect/http`'s `FetchHttpClient`), which Node 24 and Bun both have; a host or a test gives its own
  `fetch` with `FetchHttpClient.Fetch`.

### The charge is written once, around the provider's own send

- **Not a wrapper of `LanguageModel`.** Forwarding `streamText` needs a cast (ADR 0015), which the kernel does not
  write. The charge (`model-spend/`) wraps what each provider sends, whose types are its own: the OpenAI-compatible
  provider's own hooks (`LanguageModel.make`), and the Anthropic client's two sends (`createMessage`,
  `createMessageStream`), as the old plugin wraps them for its cache marks. Its lifecycle is tested over the kernel's
  `scriptedModel` before any wire.
- **The hold is the acquire of an `acquireRelease`** in the scope of the call's stream (`holdIn`, `chargedStream`,
  `chargedEffect`, `chargedSend`): taken uninterruptibly with the finalizer that closes it, so every hold the ledger
  took is closed, an interruption's included. The Anthropic client's send is an effect that gives a stream; its hold
  is in a scope of its own, closed when that stream ends, when the send fails, or when the scope the provider's
  stream runs in closes, whichever comes first.
- **Before a call is sent** it holds its worst case: the request body's bytes as input tokens (`bytesPerToken`, 1 by
  default, an upper bound for any tokenizer that reads at least a byte a token), at the dearest of the input,
  cache-read and cache-write prices, plus its output bound at the output price. The bound is the provider's
  `maxOutputTokens`, else the price's `maxOutput`, and the request is sent with it as its cap, so no answer passes
  what was held. A priced call with neither, and a call to a model with no price, are refused before they are sent,
  non-retryable, nothing held; a model the host lists as `uncapped` holds 0 and is settled at what the provider
  billed, if it says. The caps are the host's (`caps`, none by default): the ledger provided decides, as an eval
  run's caps every reservation at its budget.
- **A call the ledger refuses** sends nothing and fails with a non-retryable `AiError`. Effect AI sets an `AiError`'s
  `cause` to its reason, so the ledger's `ModelSpendExceeded` cannot be it: it rides, encoded, in the reason's
  metadata (an `InvalidRequestError` in the ledger's words, under `ModelSpend`). `spendRefusalOf(error)` reads the
  refusal back whole; `isSpendRefusal(error)` tells a budget's refusal from every other failure, a model with no
  price among them. `QuotaExhaustedError` was the nearer reason, but its words tell the reader to check an account's
  billing, which a host's own budget is not.
- **After the call** (`settlementOf`, held to a table test): what the provider reported settles it, its bill when it
  says (the gateway's `usage.cost`, read as a number or as text), else its usage at the price, the cache's reads and
  writes at their own. With nothing reported, how far the request got decides (`Reach`, which the provider's client
  marks per call, `reaching`): one that left settles at the amount held, since the provider may have billed it (a
  stream cut, an interruption, a timeout, a 5xx); one that never left releases (refused before the socket opened, a
  connection refused: `ECONNREFUSED`, Bun's `ConnectionRefused` and the like, `neverConnected`).
- **A refusal status releases too.** The rule above releases only a request that provably never left. A 4xx (but
  408) did leave, but it is the provider's refusal to start: no token was generated and none
  is billed (a refused key, no credit, a bad request, a rate limit). Settling it at the hold would spend a budget on
  calls that cost nothing, most of all on rate limits a plan retries, each retry a full hold. So `Refused` releases
  as `Unsent` does, and only a provider that bills a refusal would reopen it.
- A close the ledger fails (`ModelSpendUnavailable`) is logged: a finalizer cannot fail. A ledger that cannot be
  reached when the hold is taken fails the call, nothing sent.

### What is worth another try

A failure is an `AiError` whose reason says so (`retryable`, ADR 0015): a rate limit (429), a request that outlived
its wait (408), the provider's own failure (5xx, Anthropic's 529), a connection lost or refused, an answer that
stopped before its finish, and a wait for the headers (`timeouts.response`, a minute by default) or between two
pieces (`timeouts.idle`, two minutes) that ran out are; a refused key (401, 403), no credit (402), a request the
provider will not take (400 and the rest), an answer cut by its output cap before any word, and every refusal of the
charge are not. A stream that ends before its finish fails, on both providers, so an empty or half answer is never
stored as whole: Effect AI's Anthropic provider would end it as if it were whole.

### Which entry

The providers import no runtime module: `fetch` is a browser's too. They stay on the Node entry, and the browser
entry gains none of them. A key a page holds is readable by every script on the page, and the gateway answers a
browser's failed call without the headers the page needs to read why (the learn track's gateway model says so). The learn track's evals lessons, which run in a browser, keep the page's own gateway model
with the learner's key, and its budget stays the lesson's. The browser entry's bundle also stays free of
`@effect/ai-anthropic`. Moving a provider there later is an export, not a rewrite: its folder imports nothing a
browser lacks.

### Not ported, and gone with the old engine

The Codex WebSocket and its OAuth, the Anthropic subscription sign-in and its system block, the credential and
settings stores and their files, routing between providers and fallback models (a plan does that: ADR 0015), the
model catalog, the utility model, the HTTP proxy transport, the retry engine inside the provider (a plan retries),
images and files in a prompt (the OpenAI-compatible provider refuses a file part before it is sent), structured
output on the OpenAI-compatible wire (refused; ask for text and read it), the per-turn spend cap (ADR 0020), and the
call recorder's `model.called` facts.

## Consequences

- A host on Node or Bun reaches OpenAI, Gemini, the gateway and Anthropic without the old engine, every call charged
  to the ledger it provides; an eval run's budget caps what a first-party provider sends.
- The sdk depends on `@effect/ai-anthropic`, and its Anthropic layer is the one outside the models plugin that names
  a provider package. `effect/no-provider-namespace` is unchanged: the provider folders are not in
  `PROVIDER_NEUTRAL`, and neither are the kernel's contracts.
- A refusal of the charge is an `InvalidRequestError` to a plan: not retried, handed to a plan's next step, which
  charges the same ledger and is refused too when it is over the cap.
- The worst case counts bytes as tokens, so a long prompt holds about four times what it costs; a host that knows its
  tokenizer sets `bytesPerToken`.
- The real call recorded for this cut went through the gateway with DeepSeek V4.1 Flash, and through the gateway's
  Anthropic-compatible endpoint with Claude Haiku 4.5; Anthropic's own API is tested on recorded shapes only.

## What would reopen this

- A provider that bills a refused request: a refusal status would settle at the hold.
- A per-turn cap, or a part that chooses a model by what is left (ADR 0020's own reopeners).
- The learn track charging a browser's calls to a ledger: the providers, or the charge alone, would join the browser
  entry.
- A wire the OpenAI-compatible endpoints add that `@effect/ai-openai` speaks for all three.
