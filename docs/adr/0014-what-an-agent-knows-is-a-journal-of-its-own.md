# ADR 0014: What an agent knows across conversations is a journal of its own

- **Status:** accepted, 15 November 2026
- **Applies to:** `@xandreed/sdk/kernel` (the facts contract, the `facts` plugin, a host's memory)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

A conversation's journal holds what was said in it. What an agent should still know in the
next conversation (a name, a preference, a decision) has no place there: another
conversation has a journal of its own. Four things had to be decided: where a fact is
kept, who writes it, how a later request is sent it, and what happens when it should no
longer stand.

The journal is the only state (ADR 0003). A sub-agent already works in a session of its own
(ADR 0006). What is added to a context for one request is a wrapper's, after the memory's
own messages, and is not stored as something said (ADR 0005).

## Decision

- **A fact is a record in a session of its own**, the memory session: the first session, by
  creation, whose owner is `plugin.facts`. There is no store of facts beside the journal:
  `factsOf(journal)` folds the memory session's records into the facts that stand.
- **Two records**: `plugin.facts.learned` (the fact's id and text, and the conversation and
  turn it came from) and `plugin.facts.forgotten` (the id). Both are tagged `memory`, and
  neither may be skipped by a reader of facts that does not know it.
- **A fact is one line of 1 to 300 characters**, with no character that ends a line. It is a model's text, sent again in every
  later conversation: one that is longer, or has a second line, is refused in words the
  model reads, and never cut. Its id is `f` and a number, minted by the memory session, one
  more than the facts it ever learned: an id is not given twice, forgotten or not.
- **Two tools write**, the kernel's: `rememberFact({ fact })`, which answers the fact's id,
  and `forgetFact({ id })`. Each call is one turn on the memory session, while the
  conversation's own turn is open. They declare `Sessions` and `CurrentTurn`, so a program
  that calls them where there are no sessions does not compile. A host merges them into its
  toolkit (`Toolkit.merge(tools, factTools)`) and provides `factHandlers`.
- **A wrapper of `Memory` reads**: `withFacts({ limit })(memory)`. For each request it reads
  the facts that stand and adds up to `limit` of them, last, after the context the memory
  below returned, in a frame, as data, a line each with its id. It stores nothing.
- **Which facts**, when there are more than `limit`: those that share a word with the
  question first, then the newest (`relevant`, a pure function). The question is the last
  `conversation.user.message` of the conversation's journal (`questionOf`), read by the
  record's name: never a message of the context, where another wrapper's note is a
  user-role message too, and never any record that bears a message in that role, which a
  plugin's record in the conversation may. With `limit` facts or fewer, all are sent.
- **The note names no tool.** The wrapper and the tools are separate values, and a host may
  send the facts to a program it did not give the tools (a helper that only reads).
  `forgetFact`'s own parameter says where a fact's id is read.
- **The tools' names are the kernel's**, `rememberFact` and `forgetFact`: unlike `remember`
  and `forget`, they are names a host's own tools are unlikely to have.
- **A dead writer.** A process that dies inside a turn on the memory session leaves that turn
  open, and the next `rememberFact` is refused as busy. Only a host knows that a writer is
  gone (ADR 0010): a host on a store that outlives its process recovers the memory session
  (`memorySession`, `Sessions.recover`) as it recovers its conversation. A fact stored in
  the turn that was left open stands: a fact is its record, whatever became of its turn.
- **Two programs that each create a memory session** before either lists again both write
  to the first by creation: the store is listed again after a create, and the other session
  is never read. That is as far as it goes. The kernel assumes one writer per store (ADR
  0010): a second program whose session is stored after the first listed again, under a
  clock or an id that sorts it first, becomes the memory session, and what the first wrote
  meanwhile stays in a session that is not read.
- **A memory session written in another journal format is passed over**, as a host passes
  over such a conversation (ADR 0010): old journals are not migrated, and the facts start
  again in a new session.
- **A store that fails inside a call is a defect**, as a tool's failed append is: `callTool`
  stores it as the call's failed result. Only a text that is no fact, an id no fact has and
  a busy memory session are failures in words of their own.
- **No kit of its own.** Nothing here is a contract a host implements. The wrapper passes the
  memory wrapper kit, over a memory session that holds a fact.

## Rejected

- **Facts in the conversation's journal.** They are gone in the next conversation, which is
  the case facts exist for.
- **A store of facts beside the journal** (a table, a file). A second source of truth, with
  its own format, its own recovery and no record of where a fact came from.
- **Facts in the system text.** The start of every prompt would change whenever a fact was
  learned or forgotten, and a provider's cached prefix with it.
- **Facts first in the context.** The same cost: what is added for one request goes last.
- **Recall as a tool only.** The model must think to call it, and a small one does not. A
  host that wants it writes the tool over `rememberedFacts`.
- **A fact cut at the limit.** Half a fact says something else, in every later conversation.
- **A ranking the host passes in.** One pure function is enough to teach and to test. A host
  that ranks differently (by an embedding, by recency alone) writes its own wrapper over
  `rememberedFacts`, `questionOf` and `factsNote`, which are exported for that.
- **The tools named `remember` and `forget`.** A host's own tools take those names (the
  learn track's do), and a merged toolkit keeps only the later of two tools with one name.

## Consequences

- A call of `rememberFact` stores three records in the memory session: the turn's start,
  the fact, and the turn's end.
- **The fact's text is also in the conversation that said it**: in the parameters of the
  call the model made, as conversation. `forgetFact` does not remove it from there, and
  its own result (`Forgot f1: …`) repeats the text in the conversation that forgot it, so
  the model can say what it forgot. The conversation that learned a fact is sent its text
  twice while the fact stands: in the call, and in the facts added for the request.
- The facts added for a request are not counted by a memory's budget: they come after the
  context the memory returned. They are bounded by `limit` and by a fact's length.
- What is added changes when the question changes or a fact is learned. It is last, so the
  start of the prompt a provider cached still holds.
- With no fact that shares a word with the question, the newest are sent. That departs from
  "only the relevant ones": an agent with few facts is sent all of them, every request.
- A fact is a model's text read back to a model. It is framed as data, held to one line, and
  the frame's tag is made inert inside it; that bounds what a fact can pass for, and does
  not make what it says true.
- While another call is writing to the memory session, a second one is refused as busy,
  and the model reads that it may try again. The words say "another conversation"; a host
  that runs one step's calls at the same time gets them for its own second `rememberFact`.
- A host's own tool named `rememberFact` or `forgetFact` is replaced by the kernel's when
  the toolkits are merged, and nothing says so.
- Facts belong to the store: every agent on one store shares them.

## What would reopen this

- Two agents on one store that must not share facts: an owner the host names, held in one
  value that gives the tools, their handlers and the wrapper, so they cannot disagree.
- Facts in numbers a word match cannot rank: an `Embedder` contract, and a wrapper over it.
- A fact that must be removed from every journal that holds its text (a request to erase):
  the conversation's records would have to change, which a journal does not do today.
- A branch of a conversation (a copy of its journal): the facts are not copied, since they
  are not in it. Whether a branch should see facts learned after it was cut.
- A memory session grown too long to fold on every request: a record that sums it up, as a
  summary does for a conversation (ADR 0008).
