# ADR 0019: What an agent knows can be connected

- **Status:** accepted, 17 November 2026
- **Applies to:** `@xandreed/sdk/kernel` (the graph contract, the `graph` plugin, a host's memory)
- **Skill:** `kernel-architecture` loads this record before an architectural change

## Context

Facts (ADR 0014) are sentences that do not know of each other. "Ana works at Acme." and
"Acme is in Lisbon." are two facts; "In what city does Ana work?" shares a word with the
first and none with the second. With more facts than the limit, the word ranking sends the
newest facts about Ana and leaves out the one that answers: on seven such facts at a limit
of five, it sent "Ana lives in Porto." and dropped "Acme is in Lisbon.", and Qwen2.5 0.5B
answered "Ana works in Porto." four times in five and "Ana lives in Porto" the fifth.

Five things had to be decided: what a link is and where it is kept, who writes it, what
makes two names one thing, which links a request is sent, and in what order.

Measured before deciding (17 November 2026):

- **Order.** A note sent with the question, three lines: the chain to Lisbon and "Ana lives
  in Porto.". Qwen2.5 0.5B on WebGPU named Lisbon in 0 tries of 5 with the Porto line
  first, and in 5 of 5 with the chain first. As its own last message with ids (lesson 11's
  shape), the chain first gave Lisbon in 1 of 5 with three lines and 3 of 5 with five; the
  model often repeated a line or the question. DeepSeek V4.1 Flash, through the AI Gateway,
  named Lisbon in 3 of 3 with Porto first and 3 of 3 with the chain first; sent this
  decision's own note (`linksNote` over the seven links above), it answered both "In what
  city does Ana work?" (Lisbon) and "Where does Ana live?" (Porto) right in 3 of 3. The note
  in its final words has not been sent to Qwen.
- **Writing.** DeepSeek V4.1 Flash, offered a calculator, lesson 2's `remember` and
  `recall`, and `linkThings` and `followThings`, called `linkThings` in 9 tries of 9 and
  never `remember`: "Ana works at Acme, and Acme is in Lisbon." gave the two links each
  time, and "I work at Acme." gave `user works at Acme` each time.
- **Embeddings.** `all-MiniLM-L6-v2` (8-bit, 23 MB) loaded in 3.4 seconds and embedded
  twenty names in 45 milliseconds, on the library the site already ships. As a test of one
  name for another it failed: Lisbon~Lisboa 0.47, below Lisbon~Paris 0.58 and
  Lisbon~London 0.51; Porto~Oporto 0.29; only New York~NYC (0.93) was clear.

## Decision

- **A link is a record in a session of its own**, the graph session: the first session, by
  creation, whose owner is `plugin.graph`. `linksOf(journal)` folds its records into the
  links that stand. There is no store of links beside the journal, as there is none of
  facts.
- **Two records**: `plugin.graph.linked` (the link's id, its subject, relation and object as
  the model wrote them, and the conversation and turn it came from) and
  `plugin.graph.unlinked` (the id). Both tagged `memory`, neither skippable. A link's id is
  `e` and a number, never given twice. A name is one line of 1 to 80 characters, a relation
  of 1 to 40, refused in words the model reads when it is not, never cut.
- **The model writes links with a tool**, `linkThings`, as it writes facts: the kernel calls
  no model (ADR 0002), and a tool's call and result are in the conversation's journal.
  `unlinkThings` removes one; `followThings` reads one thing's links, so a model can reach
  further than a request was sent.
- **A thing is its normalised name**: its words in lower case (`normalName`). Nothing is
  merged by meaning (the embedding numbers above); an alias is a link like any other ("NYC
  is New York"), which keeps every record true and is undone by removing it. A link said
  again, once normalised, is not stored again: its id is answered.
- **The wrapper walks from what the question names**, `withGraph({ hops, limit, speaker? })`:
  each thing whose words are a run of the question's, and the speaker's thing when the
  question holds one of the speaker's words, which the host gives in its own language (the
  kernel holds none). It follows links from either end, up to `hops` (1 to 3) away.
- **A link is ranked by its path**: the question's words of four letters or more (shorter
  words tie anything) that the relations and names on the path to it meet, a word meeting
  another when one starts the other ("work", "works"). So "Acme is in Lisbon" ranks with
  "Ana works at Acme", the link the path took. Then fewer links away, then the newer. At
  most `limit` (1 to 50) are sent, last, best first, a sentence each with its id, framed as
  data. With nothing named, nothing is added.
- **Facts stay as they are.** The graph is a second contract beside them, and a host may use
  either or both; each adds its own note.

## Rejected

- **Extracting links with a model call of the host's**, as a `Summarizer` folds turns: a
  second call per message, made whether or not there is something to keep, and a contract
  the host must implement. The tool costs nothing when nothing is said, and the spike shows
  a model calls it.
- **Ranking by distance alone.** At a limit of five the five links one step from Ana come
  before the one two steps away that answers, as the facts' ranking did.
- **Merging names by an embedding**, in the browser or anywhere: lossy, hard to undo, and,
  on the model measured, wrong for the names that matter here.
- **A node per fact**, with the fact's words as edges: a fact's sentence is the model's;
  three named parts are what a walk can follow.

## Consequences

- An agent with a graph sends, for a question that names something, the links of a path to
  an answer before the links that merely share a thing with it. The order helps a small
  model, which leans on the first lines, and does not make it reliable: in the note's own
  shape Qwen2.5 0.5B named the city in 1 of 5 and 3 of 5 tries with the chain first, and in
  none with another link first.
- A question word of four letters that carries no meaning ("does", "with", "what") meets a
  relation that holds it, so "Where does Ana go?" ranks "Ana does not like coffee" first.
  The kernel holds no list of such words in any language; a host that minds writes its own
  wrapper over `knownLinks`, `near` and `linksNote`, or leaves its links' relations free of
  them.
- The walk reads every link of the graph session for each request: a graph of a few
  thousand links is read in full each time. A host with more writes its own wrapper over
  `knownLinks`, `near` and `linksNote`.
- A hub (a thing with many links, such as the speaker) is cut by `limit`, the links the
  question meets first.
- A question that names nothing the graph holds ("What city is it in?") is sent no links;
  the model can call `followThings`.
- The words a link holds are the model's: "user" for the person it talks with is what
  DeepSeek wrote unasked; a host that names the speaker otherwise says so in `speaker`.
- A process that dies inside a turn on the graph session leaves it busy until the host
  recovers it, as for facts (ADR 0014).

## What would reopen this

- A graph too large to read for each request: an index of the links by thing, kept as a
  fold of the same records.
- Names a word match cannot join and a model would: an `Embedder` that passes a test of
  names for one thing (ADR 0014's left-out part), measured on the models a host uses.
- A model that writes links in a shape the three parts do not hold (dates, quantities).
