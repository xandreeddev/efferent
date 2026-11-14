# ADR 0009: What the UI shows is a record tagged ui; a client folds them; the model never sees them

- **Status:** accepted, 14 November 2026
- **Applies to:** `@xandreed/sdk/kernel`, every tool that shows something and every client that draws it
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

An agent shows more than text: a table of results, a card, the progress of slow work. Three
questions decide how:

- **Where a view lives.** Kept in a client, it is gone on a reload and differs between two
  clients of one session. Kept as the model's text, it costs tokens in every later request.
- **Who writes it.** A tool knows what it found; the host's loop does not.
- **What a view is.** A closed vocabulary a client can draw, or open data each client
  interprets.

## Decision

- **A view is a record.** `plugin.render.view`, stored, tagged `ui`, may be skipped, data
  `{ id, view }`. It bears no message, so no memory sends it: the model never sees a view.
  What the model gets back from a tool that showed something is a few words of its result.
- **A view holds what the tool made, not what the model wrote.** A call's parameters are the
  model's own message, stored with the conversation and sent in every later request. A tool
  that takes its rows from the model saves nothing by showing them; one that works them out
  from a few words keeps them out of the context. The model asks; the tool makes.
- **The id is the caller's.** A tool takes it from the model as a parameter, since a handler
  is not given its call's id; a later view under the same id replaces it, and keeps its
  first place.
- **A client folds them.** `viewsOf(journal)` is pure: one view per id, the latest record's,
  in the order the ids first appeared, with the place each first appeared. Drawing live and
  redrawing after a reload are the same fold.
- **Progress is live.** `plugin.render.progress`, tagged `ui`, `{ id, done, total }`, is
  published on `Core` and never stored: what stays is the view the work ends with.
- **No render service.** A tool appends its view through the turn its call runs in
  (`CurrentTurn`, ADR 0007) and publishes progress on `Core`, which it declares too.
- **A small, closed vocabulary.** `Text`, `List`, `Table` (each row as many cells as there
  are columns, checked by the schema) and `Card`. Cells are plain text: a model may have
  written them, and a client draws them as text, never as markup. A record of a shape the
  vocabulary does not know is passed over.

## Consequences

- A reload, or a second client, draws the same views from the store.
- The model's context stays the conversation: a table a tool worked out costs the call and a
  few words in later requests, not its rows.
- Nothing bounds a view's size but its shape's checks: the host's tool bounds what it makes
  (the lesson's tables stop at 20 rows).
- The vocabulary is a choice still open: the four shapes are what the first lesson needs.
  The old engine's render plugin rendered surfaces of opaque JSON specs with component
  releases, versions, phases and a transport; the kernel keeps none of that until a client
  needs it.

## What would reopen this

- A client that must edit a view and send the edit back, which would make a view part of the
  conversation.
- A vocabulary hosts must extend with shapes of their own.
