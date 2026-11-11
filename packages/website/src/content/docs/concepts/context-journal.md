---
title: Files, memory, and the context journal
description: Follow file content from tool results into durable history, bounded model context, and long-term knowledge.
---

Efferent keeps three different things: an authoritative session journal, a
bounded presentation of that conversation for the model, and optional learned
knowledge or document indexes. Understanding their boundaries explains what
the assistant can see now, what survives a restart, and what “remember” means.

For extraction, graph storage, indexes, scores and reranking, read
[how memory learns and retrieves](/docs/guides/memory-engine/).

Start with the [five-turn interactive example](/docs/guides/memory-walkthrough/)
to inspect actual file changes, journal events, model requests and learned
memory at each step. This page explains the contracts behind that example.

## The components and their jobs

| Component | Purpose | Effect on journal and model context |
|---|---|---|
| [Sessions](/docs/plugins/sessions/) | Own turns, check owners, manage forks and queued input | Reads authorized history and commits ordered events |
| [Session files](/docs/plugins/session-files/) or [SQLite](/docs/plugins/session-sqlite/) | Persist that journal | Keeps events and head state across process restarts |
| [Workspace filesystem](/docs/plugins/workspace-local/) | Read and change actual workspace files | Does not put their contents in context by itself |
| [Workspace tools](/docs/plugins/workspace-tools/) | Expose file and command operations | Returned results and call arguments become journal evidence |
| [Window memory](/docs/plugins/memory-window/) | Fit recent conversation into a request | Records bounds, compact views, spills and ledgers without deleting originals |
| [Summary memory](/docs/plugins/memory-summary/) | Carry earlier conversation forward as a summary | Records bounds and a summary while retaining the original archive |
| [Result digests](/docs/plugins/memory-digest/) | Shorten supported tool results with a helper model | Records an accepted digest separately from the original result |
| [Memory capture](/docs/plugins/memory-capture/) | Copy selected committed evidence into processing jobs | Adds a capture checkpoint after durable enqueue |
| [Long-term memory](/docs/plugins/memory/) | Learn and retrieve reusable interaction knowledge | Stores evidence-backed facts and graph relationships separately |
| [Document RAG](/docs/plugins/rag/) | Retrieve passages from an explicitly ingested corpus | Adds cited evidence to a turn or tool result |
| [Knowledge PostgreSQL](/docs/plugins/knowledge-postgres/) | Persist native knowledge and jobs | Stores sources, vectors and graphs, independently of the journal |

## From a journal to a model request

The journal is the session's ordered record. Its events include the user's
input, assistant messages and tool calls, returned tool data, presentations,
digests, context sections, compaction decisions, usage and closing outcome.
Streaming deltas and other transient progress are not a second stored transcript.

`ConversationMemory` opens a `MemorySession` over the turn's authorized log.
That session folds recorded entries into messages. The selected policy decides
which earlier material to show verbatim, compact, summarize or omit. The SDK
then combines those messages with system instructions and active tool schemas.

```text
durable session journal
  -> authorized memory entries
  -> window or summary policy
  -> bounded messages + system instructions + active tool schemas
  -> prepared request recorded and flushed
  -> model response and tool calls
  -> returned tool data, views, digests and reply recorded
  -> acknowledged closing turn commit
  -> optional capture jobs -> extraction -> persistent learned knowledge
                                      -> evidence in a later turn
```

A host that shows the conversation can read the same journal one record at a
time. `storedRecordOf(event)` from `@xandreed/core` decodes a record by its own
kind into a typed value told apart by `kind`: the user's message
(`turn.started`), a message of the conversation (`memory.message`), a tool
call's admission, completion or refusal (`tool.started`, `tool.completed`,
`tool.refused`) and how the turn ended (`turn.ended`), among the kinds in
`StoredData`. Any other record reads as none. The stored `tool.completed`
holds whether the handler succeeded and how long it took, not its input or
result: the call is in the assistant's `memory.message` and the result is the
`memory.tool-result` with the same `toolCallId`. A record that does not decode
fails with its `SchemaError` rather than being skipped.

Before a real model step, `request.prepared` and any required `request.part`
records describe the request's system text, tool declarations, policies and
memory render recipe. Its messages remain in their original memory events.
This supports historical request reconstruction without buying another model
call. Rendering recorded history does not execute the old tool calls again.

Turn-context sections can contain retrieved knowledge. Step context belongs
to a particular loop run. They are recorded at their intended scope rather
than repeatedly appended to the stable system prefix. Provider prompt caching
can reuse a matching prefix; it is separate from journal persistence and is
not a guarantee that a provider retains conversation state.

## A concrete file-read and action walkthrough

Suppose the user asks: “Read the release notes, update the version, and tell
me what changed.” The following stages have different data and durability.

1. **The turn starts.** `Sessions` checks the owner and turn admission, then
   records the user input. Memory loads earlier authorized entries. With native
   memory enabled, bounded recall can add relevant preferences or prior decisions.
2. **The model requests a read.** Its tool call and arguments identify the file
   and requested range. The workspace tool reads real filesystem bytes through
   the configured workspace services.
3. **The tool returns a bounded result.** The built-in text read returns a line
   window, not an unlimited copy of the file. Its default window is at most
   2,000 lines and 50 KiB, within a separate file-size limit. A very long first
   line can itself be clipped; advancing the line offset cannot recover that
   line's omitted remainder. Request another window when more lines remain.
4. **The result is recorded.** The journal stores the returned encoded data and
   its presentation. “Full fidelity” means the tool's returned value, not bytes
   the tool never returned. A later view or digest can be recorded separately.
5. **The model decides what to do next.** The next request contains the result's
   current presentation. If the memory policy requests a supported digest, the
   helper can select items or summarize it. Without a usable digest, its view stays,
   bounded when it is longer than the memory policy's bound (below).
6. **The write happens.** A write or edit changes actual workspace files and
   returns a receipt or diff. Call arguments are also recorded: a write's input
   can contain the complete new text even when its result is only a small receipt.
7. **The reply and outcome are committed.** The final reply becomes journal
   evidence. Session state records whether the turn completed, failed or was
   interrupted. A tool handler returning successfully does not by itself prove
   the requested real-world outcome; inspect its domain result.
8. **Optional capture runs after acknowledgement.** Selected user input, final
   reply and tool evidence become durable memory-source jobs. Extraction,
   review and embedding finish asynchronously before new knowledge is searchable.

The tool owns its initial limits. The memory policy bounds what a long result
shows as it is written, and owns later context pressure.
Reading a clipped result back with `recall_context` cannot recover a file range
that was never returned. Read the actual file again for its current contents;
that is new evidence and can differ from the earlier journal record.

Command output has similar limits: workspace `bash` returns a bounded tail and
can provide a spill pathname for additional captured output. Transient command
progress is not the durable result. A spill file remains an ordinary filesystem
artifact with its own lifetime; the journal does not automatically import it.

## Bounding what a tool shows

A tool with no view is shown to the model as its whole result, and context
pressure acts only after a request has passed its budget, by rewriting a
result the model was already sent. Both memory policies therefore bound a
result as it is written. A result whose view is longer than
`boundOnWriteChars` (16,000 characters by default, about a twelfth of the
default budget) is shown, from the first request that includes it, as its
first 16,000 characters followed by a notice:

```text
[… 36000 more characters kept out of context; call recall_context with locator "run-1:4" and offset 16000 to read them]
```

The journal keeps the returned result and its view whole. `recall_context`
reads the rest a page at a time from that offset. The cut never splits a
character: where it would fall inside a surrogate pair, the result shows one
unit less and the notice gives that offset. Within its turn, what the result
shows changes again only when window memory spills it under pressure, so the
start of each request stays the same from one step to the next. At a later
turn's start (with `compactPreviousTurn: false`, once a later turn's request
passes its budget) window memory replaces the preview with the tool's compact
view when that is shorter.

- A tool sets its own bound with the `boundOnWriteChars` annotation of
  `defineTool`. It replaces the policy's bound for that tool, and a tool with
  no view can set it. It is a whole number of characters, 0 or more;
  `defineTool` throws on any other value.
- A tool that ends its result with its own continuation sets `0`, which keeps
  its results whole: a cut would hide exactly that last line. The workspace
  tools `read`, `ls`, `find`, `grep` and `bash` do, and so do `read_knowledge`
  and `read_memory`; their own limits bound them.
- A pinned result, a `recall_context` page and a result that holds images are
  never bounded. A result whose digest was recorded as it was written is shown
  through that digest while the digest is no longer than the bound. A failed
  call's result is bounded like any other.
- `boundOnWriteChars: 0` on the memory plugin bounds nothing from then on.
  Both memory plugins contribute `recall_context` all the same: a session
  continued at `0` still shows the results bounded earlier with their notice,
  which names the tool.

These limits apply. The result is stored first, and its bound is recorded
just after, once its view is ready (and its digest, when the policy digests on
write).

- A request built by another run of the same turn in between shows the result
  whole once.
- A write that stops in between leaves the result without a bound, shown
  whole from then on: an interruption (a cancelled turn, a sibling call that
  fails), a view or an append that fails, or a process that dies. Only window
  memory's pressure can still shorten it.
- Summary memory never reduces the current turn. Results that are each
  bounded can still pass the budget together, and the request is then sent as
  it is.
- `context.built` counts each bound among its `compactions`.
- A graph that holds both memory plugins registers `recall_context` twice and
  fails with `tools.duplicate`: list only the one the graph binds.

## Reading a shortened result on

`recall_context` takes the locator a notice shows and an `offset` (0 by
default) and returns at most 8,000 characters of the stored view from there.
While more remains, the page ends with the offset to pass next.

Within the turn that wrote a result, the tool refuses a call for text the
request already shows. Such a call would put up to 8,000 characters into the
context a second time and cost a step. It is refused with a failure the model
reads as the call's result:

- `ResultShown` when the offset is inside the text the result still shows.
  For a bounded or spilled result: `That offset was inside the text this
  result showed when you asked, so nothing was returned. To read on, pass the
  offset its shortened form shows now, or offset 0 if it shows none.` For a
  result shown whole: `This result was shown in full when you asked: nothing
  of it was left out. If it is shown shortened now, pass the offset its
  shortened form shows, or offset 0 if it shows none.`
- `AlreadyRecalled` when the offset is inside a page a call of this turn
  already returned, its start included, and that page is still shown: `The
  text from that offset is in a page you already read, shown above. To read
  on, pass offset 24000.`, or `That page ends the result.` after the last
  page.

An offset past the shown text and outside every page already read is a page,
also when it lies below a page already read and its page runs into that one
(see the limits). When window memory spills a result under pressure, the text
that left the request is served again.

A refusal stays in the conversation as its call's result, and the model reads
it again in later requests, also after memory has shortened the result it is
about: window memory spills a bounded result again under pressure, and gives
an earlier turn's result its tool's compact view. A `ResultShown` reply
therefore holds no offset of its own. It sends the model to the offset the
result's shortened form shows when the reply is read: the new notice's after
a second spill, and 0 after a compact view, which shows none. Either way the
reply leads to where the result's shown form ends when it is read. Where the
turn had already read a page from there, the call that follows the reply is
refused with `AlreadyRecalled` in the same turn, and served that page again
in a later turn, which the guard does not cover.

An `AlreadyRecalled` reply names no turn, so it stays true when it is read in
a later one: the page and the reply that calls it shown are recorded in the
same turn, and a turn leaves a request only as a whole, so the page is still
above the reply there.

Every offset inside the same shown text gets the same reply, and so does
every offset inside the same page. The step loop tells a step that repeats an
earlier one by its results, so a model that keeps asking is nudged after
three repeats and its run is stopped after five (`partial`,
`degenerate-loop`), long before the step limit. That stops a model that asks
inside one shown text, and one that steps forward inside a page it read while
six of its calls in a row fall inside that page.

These limits apply:

- The guard covers the current turn only. A result of an earlier turn is
  served from any offset, as often as asked, whatever the request still shows
  of it.
- The guard refuses only what it can tell is shown, so a call it serves can
  still return shown text: a page another run of the same turn read, and a
  result with a recorded digest under a policy that shows no digests. The
  tool's description says a call for shown text can return no text, not that
  it does.
- A call is refused by where its page would start, not by what the page would
  hold. An offset below a page already read, outside the shown text and every
  other page, is served a whole page, although most of it can be shown: asked
  1,000 characters below a page already read, the call returns 8,000
  characters of which 7,000 are in the request. Each such page is a new
  result, so the breaker counts no repeat. A model that steps downward, each
  call a little below the last page it read, still ends at the step limit, or
  under window memory fails with `context.budget` once those pages pass the
  budget.
- Two calls for the same page made together in one response are both served
  when they run at once (`limits.toolConcurrency` above 1): neither has a
  result when the other is checked. A turn runs them one after another by
  default, and the second is then refused.
- A result shown through a compact view, a digest or a custom policy's own
  preview is served from its start, as before.
- The breaker stops a model only when its steps repeat. A step that pairs a
  refused call with a call whose result is new, or that makes more refused
  calls than any step before it, counts as progress, and such a run ends at
  the step limit. A model that steps forward inside a page it read is stopped
  only while six refused calls in a row fall inside that page: the first,
  then the five repeats the breaker stops at by default
  (`limits.degenerate`). With pages of 8,000 characters that holds up to a
  stride of 1,333. With a longer stride the model reaches the next page
  first, which is new text and starts the count again: the run costs steps,
  not context, and ends at the step limit or at the result's end.
- A custom policy that shortens a recalled page makes an earlier
  `AlreadyRecalled` reply untrue of later requests. The memory plugins never
  shorten one.

Nothing is stored for the guard: a refusal is the failed result of its call.

## What compaction changes

Choose one conversation policy. Window memory keeps the current turn detailed,
compacts earlier results, spills oversized results to previews, and finally
replaces old turns with a ledger under pressure. A result bounded as it was
written can be spilled again, to the shorter pressure preview; the result
showing the most text goes first. With `currentTurnFirst`, it
replaces old turns before it spills any of the current turn's results, and
spills them only when the current turn alone does not fit. `recall_context`
pages a stored result view by locator when the model needs more.

Summary memory folds older whole turns into a helper-generated summary and
keeps a recent tail verbatim. By default it considers a summary after the reply
is sealed, with a later run's start as a safety net. It never spills under
pressure; it contributes `recall_context` for the results it bounds as they
are written. A summary can lose detail, so exact records need their source.

Result digestion is a separate operation. A tool supplies a selection or summary
task, a policy requests it, and the digest plugin runs it. Window memory can
request digestion above `digestOnWriteChars`; installing a digester alone does
not enable that trigger. Summary memory can display existing digests but does
not itself request them.

These operations append decisions and derived presentations. They do not prune
the original session archive. The journal can therefore be much larger than
one model request. Persistence is not an unlimited-context promise: system text,
tool schemas, images and current-turn content still consume a finite budget.
An irreducibly large current request can fail with `context.budget`.

## What filled each request

Before tuning a prompt, a tool's description or a memory option, measure what
the requests of a real session held. `contextReportOf(events)` from
`@xandreed/core` reads it back from the journal alone, with no model call
and no service: a row per prepared request, and a summary per turn.

```ts
import { Effect, Option } from "effect"
import { contextReportOf, Sessions } from "@xandreed/core"
import type { SessionAddress } from "@xandreed/core"

/** One line per model request of a session: what it carried, and what it cost. */
const requestLines = (address: SessionAddress) => Effect.gen(function* () {
  const sessions = yield* Sessions
  const report = yield* contextReportOf(yield* sessions.read(address), { largest: 3 })
  const count = (characters: Option.Option<number>) => Option.match(characters, { onNone: () => "none", onSome: String })
  return report.rows.map((row) => [
    `turn ${row.turn} step ${row.step}${row.resend > 0 ? ` resend ${row.resend}` : ""}`,
    `system ${row.system.characters}`,
    `tools ${row.tools.characters} (${row.tools.largest.map((tool) => `${tool.name} ${tool.characters}`).join(", ")})`,
    `results ${row.results.characters}`,
    `hook note ${count(row.hookNote)}`,
    `step context ${count(row.stepContext)}`,
    Option.match(row.built, { onNone: () => "not measured", onSome: (built) => `${built.estimatedTokens} + ${built.reservedTokens} of ${built.budgetTokens} tokens` }),
    Option.match(row.usage, { onNone: () => "no response", onSome: ({ usage }) => `${usage.inputTokens} input tokens` }),
  ].join(" | "))
})
```

Give it every event of the session from its start, as `Sessions.read`
returns them: a request's header names its system text and its tool
declarations by hash, each stored once as a `request.part` record before the
first request that names it, and each row rebuilds its request from the
memory before it. A fork needs the events it inherited too.

| A row holds | Read from |
|---|---|
| `system`, `tools`: characters and tokens of the system text and of the tool declarations, with the largest declarations by tool | the request's header and the parts it names; a declaration counts its description and the canonical JSON of its parameters, each tool estimated on its own, so the two token counts sum to `built.reservedTokens` |
| `built`: the strategy's token estimate of the messages, the reserve, the budget and the compactions applied | the `context.built` published for that request; none when the journal holds none |
| `results`: how many tool results the request showed, and their characters as shown | the render that built the request |
| `hookNote`, `stepContext`: a request hook's note and the step policy's step context, each with its own count | the step context the request showed, and the hook's patch in the header it was recorded for |
| `usage`, with its `source` | the `Loop` call that completed for the request (`model.called`), else the response its step accepted (`step.usage`) |

The messages as a whole are an estimate, `built.estimatedTokens`: the journal
stores the entries a request is rebuilt from, not a character count of the
messages, and the report invents none. A hook note or a step context the
request did not show is none; 0 is an empty text. A step context placed
after the messages (`tail`) is the latest one its run recorded, so a step
that recorded none still shows an earlier step's; one placed in the system
text is counted in `system` already (`contextPlacement`). A request sent
again in the same step, after the provider refused it for its size or over
an image, is a row of its own (`resend`); the refused one has no usage.

Each turn lists the largest tool results its requests showed, each once at
its largest size, with its tool, its characters, the run and step of that
request, and how it was shown:

| `shown` | The request showed |
|---|---|
| `whole` | the view the result was written with |
| `compact` | its tool's compact view, as an earlier turn's result |
| `digest` | a recorded digest |
| `bounded` | a preview recorded as the result was written: its first request already showed it shortened |
| `spilled` | a preview recorded later, under budget pressure |

`view` is `raw` when that text is the result's canonical JSON, whole or cut
to a preview, which is what a tool with no view shows, and `tool` when the
tool's own view wrote it. A turn also counts its `bounds`, `spills`,
`compacts`, `drops`, `summaries` and `digests`, and its `steps` separately
from its `requests`: a host-planned step prepares no request.

`compacts` is the number of results given their tool's compact view during
the turn, at its start or once a request passed its budget. It counts every
compact view recorded in the turn, whatever policy recorded it and whether or
not a request showed the result through it, as the counts beside it count
what the journal holds. A result is
listed at its largest size, so one that a request showed whole before a
later request of the same turn showed it compact is listed `whole`, by the
request that showed it so: the count is what tells you a compact view was
recorded. A turn whose requests never showed it larger lists it `compact`.

## The two kinds of checkpoint

A summary **render snapshot** stores a checked projection that accelerates
later rendering. It is validated against the archive; incompatible projections
fall back to full rendering. It does not delete history or avoid the initial
archive read and media hydration.

A memory **capture checkpoint** records how far closed-turn evidence has been
enqueued into the native store. Enqueue happens first. If acknowledgement is
lost, synchronization repeats deterministic source identities safely. Bounded
sync can report more history or an open-turn/page-limit stall; it does not mark
unprocessed evidence as captured.

Neither checkpoint means “the model has read everything,” and a capture
checkpoint does not mean extraction is finished.

## Cross-conversation memory and RAG

Native memory extracts reusable knowledge from selected interaction evidence.
It keeps citations, evidence-backed profiles, and a graph with separate world
validity and recorded-knowledge times. An inferred routine needs at least three
distinct episodes and grants no execution authority. Recalled sections, digests,
summaries and memory/RAG tool results are skipped as standalone capture events.
Final replies are still captured, and can contain proposals or repeat retrieved
material. The extraction model is instructed to distinguish those statements
from confirmed effects.

Capture reads original journaled tool-result views and arguments, before later
context presentations or digests. It does not scan every file in the workspace
or recover output the original tool omitted.

RAG starts from host-ingested document text and revisions. It preserves cited
passages and can optionally extract a temporal graph. A file read during a
conversation is not automatically a RAG ingestion. A replacement document's
old index remains searchable until the new revision publishes atomically.

Both engines use explicit owner, namespace and collection scopes; model tools
derive the owner from the current session. PostgreSQL keeps personal memory
and document retrieval in separate logical domains. Helpers and host-supplied
embeddings prepare derived data outside publication transactions.
[Models](/docs/plugins/models/) supplies language models, not embeddings.

Newly captured knowledge may not be ready for the next immediate turn. Durable
jobs, leases, stages and status let a worker or host finish processing later.
Use the original conversation as the available evidence while learning is pending.

## Files, restart, forks, and deletion

The session-files backend stores Efferent's own journal files: a format marker,
session headers and immutable revision commits containing head state and events.
Those are different from the user's workspace files. The combined file plugin
supplies `SessionLog` and open turn admission; `sessionsPlugin` adds session
management above them. The log-only variant supplies just persistence, so the
host also chooses a turn-admission policy.
[SQLite](/docs/plugins/session-sqlite/) is an alternative journal backend.

After restart, reconnect to the same durable session store, owner and session
identity to recover conversation history. An in-memory journal does not survive
process loss. Models and host services must be configured again; recovery does
not imply provider-side conversation state. Resume and takeover follow session
ownership and interrupted-turn rules, rather than blindly repeating every call.

A fork inherits an authorized parent-history prefix with a fixed ceiling.
Later parent events do not appear in that inherited prefix. A fork or request
replay does not copy, undo or restore workspace file changes. External side
effects have their own recovery and idempotency requirements.

Long-term knowledge survives only when its database survives. Workers rescan
durable jobs on startup. Graceful agent shutdown stops new turns and claims,
allows admitted work to settle within a shared deadline, then interrupts active
work before store scope closure. Queued jobs can remain for a later worker.

“Forget this” needs an explicit scope. Context compaction only changes what
the model sees. Native `forget_memory` removes a learned source and dependent
indexes and retains a tombstone, but does not erase the original session journal,
workspace file, command spill, or database backup. Journal removal, filesystem
deletion and backup retention are independent host responsibilities.

## Practical compositions

This composition keeps the journal in a durable data directory and uses a
separate workspace for file operations:

```ts
import { LanguageModel } from "effect/ai"
import { Agent } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { sessionFilesPlugin } from "@xandreed/plugin-session-files"
import { sessionsPlugin } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { localSystemPlugin, workspaceToolsPlugin } from "@xandreed/plugin-workspace"

const definition = Agent.define({
  workspace: "/srv/project",
  plugins: [
    { plugin: sessionFilesPlugin, options: { path: "/srv/assistant-data/sessions" } },
    sessionsPlugin,
    localSystemPlugin,
    { plugin: workspaceToolsPlugin, options: {
      always: ["read", "edit"], workspaceAccess: "write",
    } },
    memoryWindowPlugin,
    { plugin: toolDiscoveryPlugin, options: { grants: ["fs.write"] } },
    stepLoopPlugin,
  ],
  turnServices: [LanguageModel.LanguageModel],
})
```

Build this definition inside an Effect scope and supply a configured
`LanguageModel` to each turn, following [Getting started](/docs/getting-started/).
Set both paths for your host. Reopen the same session identity and journal
directory after restart. The `fs.write` grant permits file edits; shell execution
needs its own grant. Window memory works without a summary or digest model;
native long-term learning is added separately.

- **A durable local assistant:** session files, workspace services/tools, one
  window or summary policy, models, discovery and the loop.
- **Cheaper large tool results:** window memory with a positive digest threshold,
  the digest plugin, and tools that define supported digest tasks.
- **Continuity across conversations:** the local assistant plus PostgreSQL,
  memory, capture, a helper model, and a matching embedding service.
- **Answers from a document corpus:** add RAG and explicit host ingestion.
  Enable its graph mode only when a helper model and the extra extraction work
  are appropriate; automatic turn recall is an independent opt-in.

Start with the [getting-started composition](/docs/getting-started/) and the
[native knowledge guide](/docs/concepts/native-knowledge/) for concrete host
layer and ingestion examples. Each plugin page lists its remaining dependencies
so a configuration fragment is not mistaken for a complete running agent.
