---
title: Window memory
description: Fit a conversation into context with compact views, recoverable spills, and a turn ledger.
pluginId: "@xandreed/plugin-memory-window"
---

Window memory supplies `ConversationMemory`: the policy that turns a session's
recorded history into the messages sent to the model. Use it when you want a
bounded active conversation without paying for a summary model.

It preserves the full recorded history while shortening its presentation.
It does not learn facts across separate conversations or index documents.

## Install

```sh
npm install @xandreed/plugin-memory-window
```

Install the shared `effect`, core and SDK packages with the rest of your graph.
The plugin runs on Node 24 and Bun and requires no model credentials.

## Add to an agent

```ts
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"

const plugins = [
  { plugin: memoryWindowPlugin, options: {
    compactPreviousTurn: true,
    spillMinChars: 2_000,
    previewChars: 600,
    ledgerTurnChars: 240,
  } },
]
```

Use these entries in `Agent.define({ plugins })` with a loop, tool discovery,
a model, and session services. This fragment supplies only the context policy
and its recall capability. A durable session backend supplies persistence.

## What the model sees

A tool result longer than `boundOnWriteChars` (16,000 characters by default)
is bounded as it is written: every request shows its first 16,000 characters
(fewer with `cutAtLineBreaks`) and a notice with the locator and offset to
read the rest from. See
[bound results as they are written](#bound-results-as-they-are-written), and
[cut at line breaks](#cut-at-line-breaks) to end that preview, a spill's and
each `recall_context` page after a whole line.

At a new turn, earlier tool results use each tool's compact view
(`compactPreviousTurn`, on by default). Under context pressure, the policy
first shows earlier turns' results through the compact views they have not
taken yet, then replaces large current-turn results with a preview and
locator, then replaces the oldest turns with a short ledger. The current
admitted turn stays intact as a turn; individual results can spill. See
[keep the request prefix between turns](#keep-the-request-prefix-between-turns)
for `compactPreviousTurn: false`.

The contributed `recall_context` tool reads a shortened result from the memory
archive, up to 8,000 characters per call. Its continuation offset reads the next
page. A recalled page is never shortened. Recall cannot reconstruct content
the original tool clipped before returning it.

Within the turn that wrote a result, `recall_context` refuses a call for text
the request still shows: the start of a bounded or spilled result, or an
offset inside a page read a step ago. The call is answered with a failure
that says where to read on (`ResultShown`, `AlreadyRecalled`), and a model
whose steps repeat that call is stopped by the step loop's breaker. A page
never returns text of a page read earlier in the turn: it ends where that
page starts, and its last line says how far the text already read runs and,
when more follows it, the offset past it. Once a spill under pressure takes
text out of the request, that text is served again, and a `ResultShown`
reply written before the spill still leads to it: the reply holds no offset
of its own and sends the model to the one the result's shortened form shows
now. See
[reading a shortened result on](/docs/concepts/context-journal/#reading-a-shortened-result-on)
for the replies and the limits.

Compaction actions are recorded before they apply. They change later model
requests, leaving the original tool result and messages in the journal. A new
memory strategy can rebuild from those original entries.

## Bound results as they are written

Without a bound, an agent whose tools return large results fills its context
in a few calls, and the policy then shortens results the model has already
been sent. `boundOnWriteChars` bounds each result once, before any request
includes it:

```ts
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"

const memory = { plugin: memoryWindowPlugin, options: { boundOnWriteChars: 16_000 } }
```

A result whose view is longer than the bound is shown as its first characters
and a notice, for example `[… 36000 more characters kept out of context; call
recall_context with locator "run-1:4" and offset 16000 to read them]`. The
journal keeps the whole result. Within its turn, what the result shows
changes again only when context pressure spills it, so the start of each
request stays the same from one step to the next. If the write stops between
storing a result and recording its bound (the turn is cancelled, a sibling
call fails, the result's view or an append fails, the process dies), that
result stays without one and is shown whole until pressure spills it.

- A tool sets its own bound with the `boundOnWriteChars` annotation of
  `defineTool`; a tool that ends its result with its own continuation (an
  offset to read on from, an exit status) sets `0` to keep its results whole.
  The workspace tools `read`, `ls`, `find`, `grep` and `bash` do.
- A pinned result, a `recall_context` page and a result that holds images are
  never bounded. A digest recorded as the result was written is shown instead
  while it is no longer than the bound.
- Under pressure, a bounded result can be spilled again to the `previewChars`
  preview. The result that shows the most text is spilled first.
- At a new turn, an earlier turn's bounded result takes its tool's compact
  view only when that is shorter than what it shows.
- `boundOnWriteChars: 0` bounds nothing, as before the option.

Each bound is recorded as a compaction of the `window` strategy, so
`context.built` counts it among its `compactions`.

## Cut at line breaks

A cut by character count can fall inside a row of a result made of lines:
the result ends with half a row, and the page read from its notice starts
with the other half. Set `cutAtLineBreaks: true` to end each shortened piece
after a whole line:

```ts
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"

const memory = { plugin: memoryWindowPlugin, options: { cutAtLineBreaks: true } }
```

The option applies to the preview of a result bounded as it is written
(`boundOnWriteChars`), the preview of a result spilled under pressure
(`previewChars`) and every page `recall_context` returns. Each is cut just
after the last line break within its limit, when cutting there gives up no
more than a quarter of the limit (4,000 characters of a bound of 16,000, 150
of a preview of 600, 2,000 of a page); otherwise at the limit, as with the
option off.

- A result whose rows are shorter than that quarter is cut between two rows
  wherever the rule chooses the cut. A page still stops where a page already
  read starts, and starts at the offset its call names. A longer row can be
  cut inside its text, at the limit, past the identifier it starts with when
  that identifier is shorter than the quarter.
- A result with no line break near a limit is cut as with the option off. A
  tool with no view of its own that returns anything but text is shown as
  JSON on one line, so the option does nothing for it: a tool shows its rows
  on separate lines to gain from it.
- The limits become upper bounds: a bounded result shows 12,000 to 16,000
  characters at the default bound, and a page holds 6,000 to 8,000 (one less
  at each low end where the limit would split a surrogate pair).
- Pages have no fixed size. Read on from the offset a notice or a page's
  last line prints: adding 8,000 to the last offset skips text.
- A result a little longer than the bound can be bounded where it was shown
  whole with the option off, because a preview cut at a line break is
  shorter.
- The notice and a page's last line are the same texts. The offset each
  prints is where its cut fell.
- Results shortened before the option changed keep the text they show and
  are read on from the offset they print.
- Turned on within a turn that already spilled a result at the character
  limit, the option lets a request still over its budget spill that result
  once more, when its preview cut at a line break is shorter than the one it
  shows.
- A host that builds its own memory from `windowPolicy` contributes
  `recallCapabilityOf(id, { cutAtLineBreaks: true })` beside it. The exported
  `recallCapability` always pages at the character limit.

The option keeps the strategy id `window` and adds a suffix to its version:
`4+cut-at-line-breaks`, or `4+current-turn-first+cut-at-line-breaks` with
`currentTurnFirst`. [Context and the journal](/docs/concepts/context-journal/#cutting-at-line-breaks)
has the rule and its limits.

## Keep the request prefix between turns

A provider's prompt cache reuses a request's leading bytes. With the default
`compactPreviousTurn: true`, each new turn rewrites the previous turn's
results to their compact views, so the cached prefix ends at the first
result it rewrites. A host that prefers the cache turns the rewrite off:

```ts
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"

const memory = { plugin: memoryWindowPlugin, options: { compactPreviousTurn: false } }
```

`false` means never at a turn's start. While requests fit their budget,
nothing is rewritten. What memory records for a result then is recorded as
the result is written (its bound, and its digest with `digestOnWriteChars`),
and the result shows it from its first request. Within a turn, each request
is then the one before it, byte for byte, with more messages after.

A turn's first request extends the previous turn's last one the same way
only while everything that request showed is still shown. With the default
`turnContext: "current"`, a turn context recorded in the previous turn is
shown in that turn only: it leaves the next turn's requests, and the shared
prefix ends at that message. A turn-tier prompt section is such a context:
[long-term memory](/docs/plugins/memory/) records one with
`recallSection: "turn"`, its default, and [RAG](/docs/plugins/rag/) with
`recall: true`; a host adds its own with `turn.context`. With
`turnContext: "all"` it stays in later turns. An earlier turn's image that
later requests show as a label line (`media: "none"`, or an image that no
longer fits `maxImages` or `maxMediaChars`) ends the prefix the same way.

Compact views still apply under pressure: once a request passes its budget,
earlier turns' results take their compact views before any result is
spilled or any turn is dropped.

- Only results of turns before the current one are compacted. The current
  turn's results, pinned results and tools with no compact view are left as
  they are.
- A result takes its compact view only when that is shorter than the text it
  shows (its view, the preview of a bound or a spill, or a digest) and the
  request's estimate falls with it. The estimate counts the characters of
  each message's JSON, three to a token, so the compact view must take at
  least three fewer there. A shorter compact view that is heavier in JSON
  (a quote, a backslash or a newline takes two characters) is left alone.
- A compact view that takes one or two characters fewer there is left alone
  too, though at some lengths of the message's JSON it would lower the
  estimate by a token. A request that fit exactly under 0.21.0 by such a
  view can now spill a result or drop a turn.
- The rule reads a result's text alone. For a result that holds images it
  does not count the label lines the request adds or which images are sent
  as images, and a line memory wrote with the result for an image it never
  sends is shown again after the compact view. Such a result can take a
  compact view although the estimate does not fall.
- The fewest results that fit are compacted, the one whose compact view
  frees the most of the estimate first. A later request over budget compacts
  more, so the prefix can change at each of those requests.
- When all compact views together do not fit, all are taken and the policy
  goes on to spill and drop. A turn it then drops shows none of its results,
  so the decision records the compact views of the results in the turns
  that stay, and none for a dropped turn.
- The rest of the order is unchanged: by default the current turn's largest
  results are spilled next and the oldest turns dropped last; with
  `currentTurnFirst` the oldest turns are dropped before anything is spilled.

With `compactPreviousTurn: true` a turn's start has already compacted every
earlier turn, so pressure normally finds no compact view left to take.

## Keep the current turn's results whole

A turn that reads a large result and keeps working with it over several steps
pays for each spill: the model sees a preview and calls `recall_context` to
read back what it just received. Set `currentTurnFirst: true` to reverse the
order under pressure:

```ts
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"

const memory = { plugin: memoryWindowPlugin, options: { currentTurnFirst: true } }
```

The policy then compacts earlier turns and replaces the oldest turns with a
ledger first, keeping every result of the current turn whole. It spills the
current turn's largest results only when the current turn alone does not fit,
choosing the fewest spills and then the fewest dropped turns, and fails with
`context.budget` only when nothing fits. The default, `false`, keeps the order
above.

The option keeps the strategy id `window` and adds a suffix to its version:
`4+current-turn-first`. Compactions recorded under either order keep applying
exactly as they were recorded, while each request's `strategyVersion` (in its
recorded header and in `context.built`) shows which order decided it.

## Digests, images and budgets

`digestOnWriteChars: 0` disables eager digestion by default. To digest supported
large results on write, set a positive threshold and compose
[the digest plugin](/docs/plugins/memory-digest/). A tool must also declare a
digest task; adding the digester does not summarize every result.

`turnContext: "current"` avoids replaying obsolete turn-context sections.
Image presentation has separate `media`, `maxImages` and `maxMediaChars`
limits. Set `maxMediaChars: 0` for text-only model messages.

The available message budget excludes the system prompt and active tool
schemas. Token estimates can be calibrated by accepted provider input usage.
If the current turn still cannot fit at dispatch, the policy fails with
`context.budget`; it cannot make an arbitrarily large request fit.

## Scope and related plugins

The provider is runtime scoped, but opens an independent memory session over
each turn's authorized journal. Choose it or
[summary memory](/docs/plugins/memory-summary/) as the conversation strategy.
Using both providers requires an explicit binding and does not combine policies.

Add [long-term memory](/docs/plugins/memory/) for learned cross-conversation
knowledge or [RAG](/docs/plugins/rag/) for indexed documents. See
[context and the journal](/docs/concepts/context-journal/) for their boundaries
and [session files](/docs/plugins/session-files/) for durable local storage.

<!-- plugin-reference:start -->

## Generated configuration reference

This section is generated from the exported plugin definition by `bun run docs:generate`.

Plugin: `@xandreed/plugin-memory-window` · Version **0.23.0** · Plugin API **3** · Scope **runtime**

| Contract | Services |
| --- | --- |
| Provides | `efferent/ConversationMemory` |
| Requires | none |
| Uses when available | none |
| Contributes | `efferent/Capabilities` |

### Default options

```json
{
  "compactPreviousTurn": true,
  "turnContext": "current",
  "replies": true,
  "spillMinChars": 2000,
  "previewChars": 600,
  "ledgerTurnChars": 240,
  "digestOnWriteChars": 0,
  "digests": true,
  "media": "inline",
  "maxImages": 8,
  "maxMediaChars": 20000000,
  "currentTurnFirst": false,
  "boundOnWriteChars": 16000,
  "cutAtLineBreaks": false
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
    "compactPreviousTurn": {
      "type": "boolean"
    },
    "turnContext": {
      "type": "string",
      "enum": [
        "current",
        "all"
      ]
    },
    "replies": {
      "type": "boolean"
    },
    "spillMinChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "previewChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "ledgerTurnChars": {
      "type": "integer",
      "maximum": 9007199254740991,
      "exclusiveMinimum": 0
    },
    "digestOnWriteChars": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "digests": {
      "type": "boolean"
    },
    "media": {
      "type": "string",
      "enum": [
        "none",
        "inline"
      ]
    },
    "maxImages": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "maxMediaChars": {
      "type": "integer",
      "minimum": 0,
      "maximum": 20000000
    },
    "currentTurnFirst": {
      "type": "boolean"
    },
    "boundOnWriteChars": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "cutAtLineBreaks": {
      "type": "boolean"
    }
  },
  "required": [
    "compactPreviousTurn",
    "turnContext",
    "replies",
    "spillMinChars",
    "previewChars",
    "ledgerTurnChars",
    "digestOnWriteChars",
    "digests",
    "media",
    "maxImages",
    "maxMediaChars"
  ],
  "additionalProperties": true
}
```

</details>

<!-- plugin-reference:end -->
