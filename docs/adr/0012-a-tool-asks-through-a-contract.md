# ADR 0012: A tool asks through a contract the host provides; the answer is a record

- **Status:** accepted, 15 November 2026
- **Applies to:** `@xandreed/sdk/kernel` (the approval contract, `callTool`, the `autoApprove` wrapper)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

Some of what a tool does should not happen on a model's word alone: deleting, sending, paying.
A person has to say yes first. Four things had to be decided: who asks, who answers, what
becomes of the answer, and what the model reads when the answer is no.

The kernel has no tool service (ADR 0004): a tool is Effect AI's, run by the host's loop through
`callTool`. It has no person either: a chat, a terminal and a batch job each ask in their own
way, and one of them asks nobody.

## Decision

- **Asking is a contract the host provides.** `Approval.ask(request)` puts one request to
  whoever decides, and answers with a `Decision`. No kernel plugin implements it for a person.
  It has no failure in its type: a host that cannot ask answers `Refused`.
- **The tool asks, where it acts.** `approve({ action, detail })` is one line at the start of a
  handler: what follows it runs only on a yes. `action` names the kind of thing, the same every
  time; `detail` says what this call would do, for the person. The tool knows both, with the
  model's parameters in hand.
- **A tool that asks declares it**, `dependencies: [Approval, CurrentTurn]`, and a call of it
  through `callTool` needs `Approval`: a program that provides none does not compile where the
  type of what it runs is written out. `callTool` is typed over every tool of its toolkit, so
  what any of them declares stays in its type (`ToolNeeds<Tools>`; ADR 0007, amended). The same
  holds inside the handler: one whose tool does not declare `Approval` cannot call `approve`.
- **The answer is a record of the turn**: `plugin.approval.decided`, with the request and the
  decision, tagged `trace`, bearing no message. `approve` stores it; the host's `Approval`
  stores nothing.
- **A standing approval is that record.** `ApprovedAlways` covers the action, in the
  conversation whose journal holds it: `grantsOf(journal)` is the fold, and `approve` reads it
  before it asks. So a grant is there after a restart, is not there in another conversation,
  and needs no store of its own.
- **Four decisions:** `Approved`, `ApprovedAlways`, `Refused`, and `Allowed`, a yes given by
  the host's policy with nobody asked. The record says which, so a journal tells a person's
  yes from a policy's.
- **A refusal is the call's result.** `approve` fails with a fixed text (`APPROVAL_REFUSED`,
  and nothing else: its failure type is that text, `ApprovalRefusal`),
  which `callTool` stores as the failed result the model reads. It names no detail: the call
  it answers says what was asked. The turn goes on.
- **It fails closed.** An answer that is no `Decision` (untyped code can answer anything)
  approves nothing, and nothing is stored, since nobody decided. A host that dies while it is
  asked approves nothing. Untyped code that provides no `Approval` at all runs, and the call
  fails with "Service not found: @xandreed/sdk/kernel/Approval" as its result: the tool does
  not act.
- **A long detail is cut, not refused.** The detail is built from what the model sent, so its
  length is not the tool's to promise: over 2,000 characters it keeps its start and says how
  many were cut, and the person is asked all the same. An action is the tool's own word: an
  empty one, or one over 200 characters, is the tool's mistake, said as the call's failed
  result with nobody asked.
- **A policy is a wrapper.** `autoApprove(allows)` is a higher-order plugin over `Approval`:
  what the policy allows is answered `Allowed`, and every other request goes to the wrapped
  one. It never answers `ApprovedAlways`.
- **A loop can ask too.** `approveIn(session, request)` is the same rule for a loop that asks
  before it runs any call. It stores a refusal as the call's result itself
  (`toolResult(call, refusal, true)`): a call with no result is not sent again (`paired`), and
  the model would never read that it was refused.
- **No kit.** The one rule an implementation could break, answering with something that is no
  decision, is held where the answer is used: `approve` decodes it.

## Rejected

- **An annotation on the tool that makes `callTool` ask.** Every loop would then need
  `Approval`, whether a tool asks or not, and the request would be built without the tool's
  own knowledge of what the call is about to do.
- **A table of permissions in configuration.** A second source of truth beside the journal,
  and a grant that changes when the configuration does.
- **A grant stored outside the journal**, or a grant a policy can mint. It would outlive the
  conversation, or the configuration, that gave it.
- **A refusal as a tagged error.** In a tool whose failure is text, the convention here, it
  reaches the model as an encoding failure, not as the refusal's words.
- **A refusal that fails the turn.** A no is an answer: the model reads it and goes on.

## Consequences

- A tool that asks declares a failure that is text (`failure: Schema.String`,
  `failureMode: "return"`): typed code does not compile otherwise.
- `callTool`'s effect now requires what the toolkit's tools declare, less `CurrentTurn`. A
  program that provided a tool's dependency to the handlers' layer alone provides it to the
  program instead.
- The page of a host runs while it waits for an answer: the turn is open until the person
  decides. Interrupting the turn drops the question, and nothing is stored.
- Grants only grow in this cut: nothing revokes one but a new conversation.
- A sub-agent's session has its own journal (ADR 0006): a grant in the caller's is not one in
  the helper's.

## What would reopen this

- A host that needs to revoke a grant, or to grant across conversations: a record for it, and
  a rule for which journal is read.
- A branch of a conversation (a copy of its journal): whether it inherits the grants it copied.
- A request that must show more than text (a diff, a file): `detail` would become a view.
