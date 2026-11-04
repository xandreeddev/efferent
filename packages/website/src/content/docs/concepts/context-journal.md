---
title: Files, memory, and the context journal
description: Follow file content from tool results into durable history, bounded model context, and long-term knowledge.
---

Efferent keeps three different things: an authoritative session journal, a
bounded presentation of that conversation for the model, and optional learned
knowledge or document indexes. Understanding their boundaries explains what
the assistant can see now, what survives a restart, and what “remember” means.

## The components and their jobs

| Component | Purpose | Effect on journal and model context |
|---|---|---|
| [Sessions](/docs/plugins/sessions/) | Own turns, check owners, manage forks and queued input | Reads authorized history and commits ordered events |
| [Session files](/docs/plugins/session-files/) or [SQLite](/docs/plugins/session-sqlite/) | Persist that journal | Keeps events and head state across process restarts |
| [Workspace filesystem](/docs/plugins/workspace-local/) | Read and change actual workspace files | Does not put their contents in context by itself |
| [Workspace tools](/docs/plugins/workspace-tools/) | Expose file and command operations | Returned results and call arguments become journal evidence |
| [Window memory](/docs/plugins/memory-window/) | Fit recent conversation into a request | Records compact views, spills and ledgers without deleting originals |
| [Summary memory](/docs/plugins/memory-summary/) | Carry earlier conversation forward as a summary | Records a summary while retaining the original archive |
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
   helper can select items or summarize it. Without a usable digest, its view stays.
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

The tool owns its initial limits. The memory policy owns later context pressure.
Reading a clipped result back with `recall_context` cannot recover a file range
that was never returned. Read the actual file again for its current contents;
that is new evidence and can differ from the earlier journal record.

Command output has similar limits: workspace `bash` returns a bounded tail and
can provide a spill pathname for additional captured output. Transient command
progress is not the durable result. A spill file remains an ordinary filesystem
artifact with its own lifetime; the journal does not automatically import it.

## What compaction changes

Choose one conversation policy. Window memory keeps the current turn detailed,
compacts earlier results, spills oversized results to previews, and finally
replaces old turns with a ledger under pressure. `recall_context` pages a stored
result view by locator when the model needs more.

Summary memory folds older whole turns into a helper-generated summary and
keeps a recent tail verbatim. By default it considers a summary after the reply
is sealed, with a later run's start as a safety net. It has no built-in spill
recall tool. A summary can lose detail, so exact records need their source.

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
