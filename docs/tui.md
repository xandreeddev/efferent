# The efferent TUI

A field guide to the terminal UI — what the panes are, how you move around them, and
every key and `:` command. Up to date with `main`.

> **What it is.** A **modal, multi-pane** terminal UI rendered by **OpenTUI** (a native
> Zig renderer driven over Bun FFI) with a **SolidJS** signal graph on top — **no React,
> no Ink, no hand-rolled ANSI**. Assistant prose is real `<markdown>`; file edits are real
> `<diff>`; fenced code and diff hunks are tree-sitter syntax-highlighted. The layout is
> Yoga/flexbox boxes, not string-pasting.

For *architecture* (how the TUI is wired to the Effect runtime), see `packages/cli/CLAUDE.md`.
For *what's shipped at a glance*, see `README.md`. For *what's deferred*, see `docs/roadmap.md`.

---

## The screen

Top to bottom, the TUI is five stacked regions:

```
┌─ conversation ─────────────────────────┐ ┌─ activity ─────┐   ← the two read-only panes,
│ the event rail: your prompts, the       │ │ context  18k/1M│     one empty column between
│ agent's prose, tool calls, diffs        │ │ tok out    1.2k│
└─────────────────────────────────────────┘ └────────────────┘
┌─ conversation · NORMAL ──────────────────────────────────────┐  ← keybind box
│ nav   ^h/j/k/l move pane · : cmd · / search · z zoom · ^C quit│     (focused pane's accent;
│ conv  j/k scroll · {}/[] para/msg · ⇥/↵ fold · gg/G · / · Z   │      title = pane · MODE)
└───────────────────────────────────────────────────────────────┘
 :model  …                                                          ← `:` palette OR `/` status
┌─ input · INSERT ─────────────────────────────────────────────┐   ← the composer (1→8 rows)
│ run the tests                                                 │
└───────────────────────────────────────────────────────────────┘
 gemini-3.5-flash · 18k (12k cached) / 1M · sqlite · ~/proj        ← status bar
 logs: ~/.efferent/efferent.log · ⇧↵ send · esc interrupt · ^C     ← dim footer
```

Modal overlays (`:model`, `:login`, `:settings`, …) float over everything on an
absolutely-positioned layer.

---

## Panes, focus, and modes

There are **three focusable panes**: **conversation** (left), **side** (right), and **input**
(the composer). The focused pane's border + title brighten to its accent — **conversation =
cyan, side = magenta, input = green** (unfocused = gray).

| Action | Keys |
|---|---|
| Move focus between panes | `Ctrl-h` / `Ctrl-j` / `Ctrl-k` / `Ctrl-l` (or `Ctrl-←/↓/↑/→`) |
| Zoom the focused pane | `z` |
| Quit | `Ctrl-C` (press twice — the first press arms it) |

Each pane has a **mode**, shown in the keybind box title as `<pane> · <MODE>`:

- **Input is `INSERT`** — you're typing a message.
- **The two read-only panes are `NORMAL`** — a vim-style **fold cursor** moves over the
  pane's logical rows. `i` from the side pane drops back into the input.

> The keybind box always shows two rows: a dim global **`nav`** row (identical everywhere)
> over a row of the **focused pane's real keys**.

---

## The conversation pane

A Claude-style **event rail**. Each block is separated by a blank line so the pane breathes.

- **Your prompts** lead the turn.
- **Assistant prose** renders as **markdown** — headings, bold/italic, inline code, lists,
  links; the `●` bullet floats top-left so the prose wraps with a clean hanging indent.
- **Tool calls** each lead with a `●` (colour = run/ok/error). The header reads
  `ToolName(arg)`; the result hangs under a `⎿` connector. `edit_file` results render as a
  real unified **`<diff>`** with `+/-` colouring and line numbers.
- **Fenced code blocks and diff hunks** are **syntax-highlighted** via tree-sitter
  (grammars bundled: JS/TS/markdown/zig; others render un-highlighted).

### Turns and tool groups (folding)

- A **turn** ("commit") is one user message and everything it produced. `⇥`/`↵` collapses it
  to `▸ <subject> · N steps`.
- A **big or multi-line user message** (e.g. a resumed handoff summary) shows just its first
  line as the subject and keeps the full text in the foldable body — so it collapses like any
  turn instead of being an un-foldable wall.
- A **run of ≥2 tool calls** in a turn **aggregates into one collapsed-by-default line** —
  `▸ read · grep · edit  (3 tools, +5 -2)` (repeated verbs collapse to `read ×3`; the rolled-up
  diffstat and any running/failed counts ride along; the caret takes the group's aggregate
  colour, so a failure shows through the fold). `⇥`/`↵` expands it to the individual pills.

### Moving around

`j/k` (and `↓/↑`) **scroll lines**; the **fold cursor** moves by logical unit and tints the
current one (scrolling it into view as it goes):

| Action | Keys |
|---|---|
| Scroll one line | `j` / `k` · `↓` / `↑` |
| Half page / full page | `Ctrl-D` / `Ctrl-U` · `PgDn` / `PgUp` |
| Cursor: prev/next paragraph | `{` / `}` |
| Cursor: prev/next message | `[` / `]` |
| Cursor: first / last unit | `gg` / `G` (jumps to absolute top/bottom) |
| Fold the unit under the cursor | `⇥` / `↵` · `h` / `l` · `←` / `→` |
| Fold **all** turns (toggle) | `Z` |
| Search this pane | `/` (then `n` / `N` to cycle, `Esc` to clear) |
| Copy the mouse selection | `y` |

---

## The side pane

The right pane has **two views**: the default **activity dashboard** and the **context
viewer** (toggled with `:context`).

### Activity (default)

A live dashboard of the run:

- **Context gauge** — tokens used vs the model's window (cached tokens shown dim).
- **Cumulative** output tokens, turns, elapsed time; **per-LLM-call** usage + duration.
- **Files changed** — a `+/-` diffstat per file.
- Foldable **skills** and **instructions** sections.

It has its own block cursor; **a new user message collapses the previous run's tree**.

| Action | Keys |
|---|---|
| Move the cursor | `j` / `k` · `{` / `}` |
| Jump to the next head (turn / section) | `[` / `]` |
| First / last row | `gg` / `G` |
| Fold a tree node or a section | `⇥` / `↵` · `h` / `l` · `←` / `→` |
| Search the rows | `/` |
| Back to the composer | `i` |

### Context viewer (`:context`)

A navigable tree of foldable, **selectable** turns and handoffs. It partitions the
conversation into **archived** segments (folded away, not loaded into the model) and the
**loaded** segment — so you can *see* what a handoff replaced.

| Action | Keys |
|---|---|
| Move / fold / jump | `j` `k` · `{` `}` · `[` `]` · `gg` `G` · `⇥`/`↵`/`h`/`l`/`←`/`→` |
| Jump the conversation to a unit | `↵` (Enter) |
| **Select / deselect** a turn or a handoff | `Space` |
| **Build a new session** from the selection | `b` (or `:build`) |
| Search the rows | `/` |

Selecting a **handoff** contributes only its summary (one synthetic message), not the folded
originals — so a handoff and its own inner turns are mutually exclusive (picking one clears the
other). The original conversation is never modified; `:build` seeds a *new* one.

---

## The input composer

A multi-line `<textarea>` that grows from 1 to 8 rows.

| Action | Keys |
|---|---|
| Insert a newline | `Enter` |
| **Send** the message | `Shift-Enter` (also `Alt-Enter`) |
| Interrupt a running turn | `Esc` |
| Recall sent-message history | `↑` / `↓` (on an empty single-line buffer) |
| Open the command palette | type `:` |
| Start a pane search | type `/` |

While a `:` command or `/` search is being typed:

- **`Enter` runs it** outright (no Shift needed).
- **`⇥` / `→`** completes the highlighted palette entry.
- **`↑` / `↓`** move the palette highlight (in command mode) — they don't recall history there.

---

## Commands (`:` palette)

Type `:` to open the palette; it filters by prefix as you type, `Enter` runs the highlight,
`⇥`/`→` completes it. Commands take a `:` prefix (vim ex-style); `/` is reserved for search.
A unique prefix resolves (`:mod` → `:model`).

**Session & history**

| Command | What it does |
|---|---|
| `:clear` | Clear the scrollback |
| `:reset` | Start a fresh conversation (forgets history) |
| `:handoff` | Summarize & hand off — replace the loaded history with a brief, keep the originals |
| `:context` | Toggle the context viewer (turn tree — `Space` select, `b` build) |
| `:build` | Build a new session from the turns selected in `:context` |
| `:browse` | List the conversations in this workspace |
| `:resume <#\|id>` | Resume one (a `:browse` number or a raw id) |

**Model & providers**

| Command | What it does |
|---|---|
| `:model [id]` | Open the model picker (↑↓ / filter / ↵), or `:model <id>` to switch |
| `:effort [level]` | Pick the thinking/reasoning effort |
| `:search [target]` | Web-search model picker, or `:search openai:gpt-4o` / `default` |
| `:login` | Add a provider — subscription (OAuth) or API key |
| `:logout <provider>` | Remove a provider's credential |

**Appearance & config**

| Command | What it does |
|---|---|
| `:theme [name]` | Switch the colour theme (↑↓ / ↵), or `:theme <name>` — ships `one-dark` + `tokyo-night` |
| `:settings` | Open the settings modal (arrow + ↵ to edit) |
| `:set <key> <value>` | Update a config setting, e.g. `:set maxSteps 30` |
| `:db [pg <url>\|sqlite [path]]` | Show or set the conversation store (trailing `global` writes `~/.efferent/config.json`) |

**Meta**

| Command | What it does |
|---|---|
| `:help` | Show keybindings and commands |
| `:cwd` | Print the workspace directory |
| `:exit` / `:quit` | Quit |

---

## Search, selection, and yank

- **`/` searches the focused read-only pane.** Typing `/` in a pane seeds the composer; the
  match jumps into view with an `[i/N]` counter, `n`/`N` cycle, `Esc` clears. The current match
  is highlighted and the fold cursor parks on it.
- **Selection is OpenTUI's native mouse** (`useMouse:true`): drag to highlight. **`y`** (in a
  read-only pane) copies the highlighted selection to the system clipboard via **OSC 52** —
  `Ctrl-Shift-C` does the same. (Copying assistant *prose* may come back empty: it's a native
  markdown component, which doesn't expose selectable text the way plain text rows do.)
- The input `<textarea>` owns its own selection and editing while you type.

---

## Theming

The colours come from a two-tier design system: a `palette` of raw values feeds a set of
**semantic tokens** every view paints against. A **theme is one complete set of token values**;
`:theme` swaps the whole UI live (code highlighting included) with no restart, and the choice
persists to `config.json`. Ships **`one-dark`** and **`tokyo-night`**.

---

## Overlays

Several commands float a modal picker over the UI — all share the same select/prompt shapes:

- **`:model` / `:effort` / `:search` / `:theme`** — a filterable select list (↑↓ / type to
  filter / ↵ to choose).
- **`:login`** — a small state machine: *Use a subscription* (OAuth) **or** *Use an API key* →
  pick a provider (status-tagged) → paste a masked key **or** run the browser OAuth flow →
  usable that same turn, no restart.
- **`:settings`** — an editable table of config knobs.

---

## Startup

With no `--resume`, if the workspace has prior conversations the TUI floats a **startup
picker** — a leading "＋ Start a new conversation" row, then `<date> · <first-prompt>` per
conversation. `Enter` resumes; `Esc` (or "start new") leaves you in a fresh session. No prior
conversations → straight to an empty rail.

If no provider credential exists yet, the rail shows a `:login` hint and sending a message
short-circuits to the same hint — run `:login` to add one.

---

## Status bar & footer

- **Status bar:** `model · tokens · storage · cwd`. Tokens read `used (cached) / window`, with
  cache-read tokens dim.
- **Footer:** the log path plus the send/interrupt/quit reminders.

---

## Deferred

What the TUI **doesn't** do yet (see `docs/roadmap.md` for the full backlog): token-level
streaming (the loop is `generateText` per turn, so prose lands a turn at a time, not
token-by-token); charwise vim motions (`w/b/e`) and VISUAL mode; an interactive per-command
bash-approval modal; syntax highlighting beyond JS/TS/markdown/zig; and a few search-highlight
refinements.
