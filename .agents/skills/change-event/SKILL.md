---
name: change-event
description: Add or change a kernel event or a stored record in efferent — storedEvent vs liveEvent, the name's owner prefix, tags, skippable, a plugin's vocabulary and UnknownRecord, the journal format (JOURNAL_FORMAT) and the journal fixtures. Read before defining a storedEvent or liveEvent, or changing the data of one.
---

# Add or change an event

The kernel's journal holds records, and `Core` carries live events. The set
is open: core holds no list of names, and every plugin defines its own
(`docs/kernel.md`, ADRs 0002 and 0003). A record outlives the code that
wrote it, so its name, tags and data are a stored format.

## 1. Decide what it is

- Published and never stored (progress, a pressure reading, a trace of side
  work): `liveEvent(plugin, event, { data, tags })`, named
  `plugin.<plugin>.<event>`, published through the open session or the
  turn (`publish(definition, data)`).
- Stored in the journal: `storedEvent(plugin, event, { data, skippable, tags })`,
  appended through the open session (`session.append(stored(definition,
  data))`). A record that bears a message carries it in the envelope's
  `message`, and is the conversation's only when tagged `conversation`.
- Neither: data a tool returns is its result (`callTool` stores it), and
  what the UI shows is a view record (`showView`).

## 2. Name and tag it

- The name says who owns the contract that defines it: `core.` for core's
  own (`core.session.turn.started`), `conversation.` for the conversation's
  records, `plugin.<plugin>.<what>` for a plugin's (`plugin.window.dropped`,
  `plugin.knowledge.memory`). A body's append of a `core.` record is
  refused (`ReservedName`).
- Tags say what a record is for, so a reader takes only what it rebuilds
  from: one of `RESERVED_TAGS` (`conversation`, `turn`, `memory`, `ui`,
  `trace`) or a plugin's own `<plugin>.<tag>`. A one-word tag that is not
  reserved does not type.
- `skippable`: whether a reader that does not know the record may pass over
  it. Say yes only for a record nothing needs to rebuild what it reads
  (`plugin.approval.decided`, `plugin.knowledge.restated`).

## 3. Its vocabulary

A plugin reads a journal through its vocabulary (`vocabularyOf(plugin, own,
over)`, `readJournal`): the records under its prefix that it knows. A record
under its prefix that it does not know is refused with `UnknownRecord`
unless it is skippable; a record under another prefix is not its to judge.
A new record a plugin's own readers must read goes into that plugin's
vocabulary (`KNOWLEDGE_VOCABULARY`, `SUMMARY_VOCABULARY`); a test holds a
journal with an unknown record read both ways (`unknown-records.test.ts`).

## 4. Changing what is stored

- Adding a record: a kernel that does not know it refuses it where its
  plugin reads (`UnknownRecord`) unless it is skippable. Decide which, and
  say it in the CHANGELOG.
- Changing a record's data (a key, a type, an optionality, a check), or the
  envelope: a journal of today's format must still decode, record by record,
  with today's definitions (`packages/sdk/src/kernel/node/journal-compat.test.ts`
  replays every fixture of `JOURNAL_FORMAT`). A change it cannot decode bumps
  `JOURNAL_FORMAT` (`packages/core/src/kernel/session.entity.ts`) by one: a
  turn then opens only on a journal of the new format, an older one is
  refused (`FormatMismatch`) and left as it is. Never add a migration or
  compatibility decoding. Name the new format in a CHANGELOG **Breaking**
  entry with its **Migration** step (start a new session; read old ones with
  the release that wrote them).
- Never re-record a released version's fixture. `bun scripts/record-journal-fixture.ts`
  records the current version's at release time (skill `release`) and
  refuses to overwrite it; `--unreleased --force` refreshes only
  `journal-unreleased.json`. A record the stock plugins store that the
  recorder's host does not produce is not covered: extend the recorder's
  program, and the compatibility test's list of definitions.

## 5. Readers and folds

A fold over a journal (`turnsOf`, `factsOf`, `knowledgeOf`, `grantsOf`,
`viewsOf`) is pure and total: it passes over a record it does not know.
Its table test holds the new record, and one it must pass over.

## Checklist

- [ ] Live or stored: decided
- [ ] Name under its owner's prefix; tags declared; `skippable` decided
- [ ] The plugin's vocabulary knows it; `UnknownRecord` behaviour tested
- [ ] A stored-data change still decodes the fixtures of `JOURNAL_FORMAT`, or bumps it with a Breaking entry
- [ ] Recorder and compatibility test cover a new stock record
- [ ] Folds pass over what they do not know; CHANGELOG entry
- [ ] `env -u HTTP_PROXY -u HTTPS_PROXY bun test packages/core/src/kernel packages/sdk/src/kernel`
