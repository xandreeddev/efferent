# ADR 0018: A background task reports in a turn of its own

- **Status:** accepted, 16 November 2026
- **Applies to:** `@xandreed/core` (`conversation.user.message`'s data, `userMessage`), `@xandreed/sdk`
  (the `Tasks` contract, the `tasks` plugin, the task tools, `turnsOf`, `questionOf`)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

A person asks for something that takes a while, and wants to go on talking meanwhile. A sub-agent (ADR 0006) works
in a session of its own, but the call that asks it waits for its answer, so the conversation waits too. Work that
goes on while the conversation does needs three things decided: where it runs, how its result comes back, and what
the result is in the journal.

Two constraints came out of trying the obvious answers. The kernel's `Inbox` runs the host's turn for each message it
queues; that turn offers the tool that starts a task, so it needs `Tasks`, and a `Tasks` that delivered through the
`Inbox` would need it back: a layer cycle. And a report stored as an ordinary user message is read as the person's
words by everything that reads the person's words: a chat, a fold of what was asked, a test's read of the turns.

## Decision

- **A task is a child session and a turn in it, on the plugin's scope.** `Tasks.start(parent, task)` creates a
  session (owner `plugin.tasks`, `parent` the caller's) and runs one turn in it on a fiber of the plugin, through the
  host's work (`TaskRun`: a session and the task's text to an answer), and returns at once with the task's id and
  session. The kernel calls no model: the work is the host's helper.
- **The report comes back to the program, which answers it in a turn of the conversation's own.** When a task ends,
  the plugin hands its report to `TaskReports.deliver`, a contract the host provides: it puts the report into the one
  queue the program's loop takes the person's messages from. The loop takes one item between turns and runs one turn
  for it, so a report never enters a running turn, and a message sent during a turn waits for it as before. No
  `Inbox`: the program's queue is the one queue, and there is no cycle. A task counts as running until its report is
  delivered, so a delivery that waits keeps its slot.
- **A report is a user message that says who sent it.** `conversation.user.message` gains an optional `from`, the
  session that sent the message when it was not the person. `taskReport(report)` is the draft the program stores: the
  report's words as the message, the task's session as `from`. The words are a `hostNote` naming the task and how it
  ended, then its answer, or why it failed, `framed` in `<task-result>` as data and cut at 4,000 characters. The key
  is optional, so every journal written before it reads the same and the format does not change. `turnsOf` gives a
  message's `from`; facts' `questionOf` passes over a message that has one.
- **A cancelled task reports nothing**, and neither does a task the plugin's close cuts short (Stop, a rebuild, a
  process's end): `cancelTask`'s result says the task was cancelled. A session cancels only the tasks it started. A failed task reports why: its own words, or
  fixed ones for a defect.
- **Bounds.** At most `running` tasks at once (four by default): the next is refused in words. A task's text is at most 2,000
  characters: the helper sees only it, and the call that starts the task keeps it.
- **Two tools**: `startTask` and `cancelTask`, each declaring `Tasks` and `CurrentTurn` (the caller is the parent,
  and the one session that may cancel). A program that calls them provides `Tasks`; a `TaskRun` that does not need `Tasks` cannot start
  a task of its own, which keeps tasks one level deep unless the host gives its helper `Tasks` on purpose.
- **No kit.** One plugin implements the contract, held by its own tests; a kit comes with a second.

## Consequences

- Reports live in the process. A task's work is cut short when the plugin's scope closes, and a report the host's
  queue still holds is the host's: a page that rebuilds its program keeps or drops it as its queue does. A task whose process died leaves its session's turn
  open, closed by `Sessions.recover` as any other.
- Two sessions call the model at once: the conversation's turn and a helper's. A model that runs one call at a time
  (a GPU in a browser) queues the second; nothing in the kernel changes for it.
- Task ids (`t1`) start again with the plugin; a session never repeats, so a client keys a task by its session.
- What a task did is in the journals: its start is the call and its result in the parent's journal, its work the
  child's own journal (its turn's end says how it closed), its report the message of the parent's turn that answers
  it.

## Rejected

- **Delivery through the `Inbox`**: a layer cycle, and a second queue beside the program's own messages.
- **`Stream.merge` of the person's messages and the reports**: it reads ahead, so a message leaves the chat's queue
  while a turn runs and can no longer steer it.
- **A take of the next report raced with a take of the next message** (`Tasks.next`): it is safe only while a take
  that loses the race has taken nothing, a promise of the queue's scheduling that held in a spike of 2,000 rounds
  and that no test of the kernel's would keep. One queue needs no such promise.
- **A report as a record of the plugin's own**: the stock memories send only the conversation's records, so the model
  would never read it.
- **A report as a plain user message**: the person's words and a helper's text could not be told apart.
- **A cancelled task that reports**: the cancel's own result already says it, and a report after it would ask the
  model to answer for a task the person stopped.

## What would reopen this

- Reports that must outlive the process: a durable queue, and a rule for a report whose parent is gone.
- A second implementation of `Tasks`: a kit.
- A message from another sender than a task (a webhook, another agent): whether `from` stays a session.

A change to this decision is a new record that supersedes this one; this one is not edited.
