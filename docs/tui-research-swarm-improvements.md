# TUI UX/UI Research: Swarm Perspective Improvements

> Research date: 2026-06-28  
> Scope: `packages/cli/src/cli/` — the OpenTUI + SolidJS TUI  
> Inspiration: `agy` (Antigravity CLI) — observed live in tmux  

---

## 1. Current TUI Architecture

### Layout (chat-first, 50/50 split)

```
┌──────────────────────────────────────────────────────────────┐
│ efferent                              ◆ 2 agents · haiku     │  ← Header (wordmark + fleet chip)
├──────────────────────────────┬───────────────────────────────┤
│ assistant                    │ ► fleet · this session's fleet│  ← Breadcrumb │ Fleet tree title
│                              │                               │
│ ● How can I help?            │ ├─ ● haiku (packages/cli)     │  ← Chat rail  │ Tree rows (git-graph)
│                              │ │   · ok · seed:task          │
│ ▸ read · grep · edit         │ │                             │
│   ├─ read(main.ts)           │ └─ ● audit (packages/core)    │
│   ├─ grep("TODO")            │     · running · seed:task     │
│   └─ edit_file(...)          │                               │
│                              │ ───── selected ─────          │  ← Node detail (live mirror)
│ user: test                   │ ● haiku · ok · seed:task      │
│                              │   · 3 files changed            │
│                              │                               │
├──────────────────────────────┴───────────────────────────────┤
│ ⣻ thinking 4s                                                │  ← Running loader (agy heartbeat)
│ ▸ queued message...                                          │  ← Pending queue
│ ⚠ 1 decision needs you                                       │  ← Decisions bar
│ ──────────────────────────────────────────────────────────── │  ← Input fence (rules)
│ > Message…                                                   │  ← Composer
│ ──────────────────────────────────────────────────────────── │
│ ↑/↓ Navigate · enter Select · tab Complete                   │  ← Bottom menu (command palette)
│                                                               │
│ ? for shortcuts  ▓░░░░░░ 12% 38k/200k · sqlite · ~/efferent  │  ← Status bar (2 rows)
│ ● general claude-sonnet-4   code claude-sonnet-4   fast ...  │     (roles row)
└──────────────────────────────────────────────────────────────┘
```

### Three Focus Panes (cycled by Tab / `w`)

| Pane | Key | Accent | Role |
|------|-----|--------|------|
| **Input** | `^j` / `↓` | green (`tokens.accent.input`) | Composer + command palette |
| **Chat** | `^h` / `^k` / `↑` | cyan (`tokens.accent.conversation`) | Conversation rail (always assistant) |
| **Tree** | `^l` / `→` | magenta (`tokens.accent.side`) | Fleet tree + node detail |

### Key Files

| File | Role |
|------|------|
| `view/App.tsx` | Root layout — chat-first split, overlays |
| `view/panes/Conversation.tsx` | Left pane — markdown, diffs, tool pills, search |
| `view/panes/AgentPane.tsx` | RIGHT pane preview — when you ↵ into a node |
| `view/panes/FleetTree.tsx` | Right pane — git-graph tree + node detail |
| `view/panes/side/ContextTree.tsx` | The tree rows (rail + connector + status glyphs) |
| `view/panes/side/NodeDetail.tsx` | Live detail below tree (status, tools, plan, files) |
| `view/panes/Input.tsx` | Composer (textarea, Enter submits, Shift+Enter newline) |
| `keys/dispatch.ts` | All key routing — 676 lines of vim-inspired nav |
| `commands/runCommand.ts` | `:command` execution — 37 commands |
| `state/store.ts` | Signal store — conversation + side + session + ui + overlay |
| `presentation/sidePane.ts` | Tree nav reducers, row flatteners, cursor logic |
| `presentation/contextTreeView.ts` | `buildNavRows` — git-graph tree flattening |
| `presentation/agentState.ts` | Phase machine — idle / thinking / tool + fleet |

### What Works Well

1. **Borderless, agy-inspired chrome** — no floating modals, inline contextual menus, rule-based input fence, accent-coloured caret by mode.
2. **Fleet tree always visible** — git-graph rail (`│ ├─ └─`), status glyphs (●/✓/✗), live detail below cursor.
3. **Running loader above input** — `⣻ thinking 4s`, agy heartbeat pattern. Never buries the cue.
4. **Command palette** — `:token` auto-completes, `↑/↓` navigate, `Tab` completes, `↵` runs.
5. **Search** — `/query` with `n/N` cycling, word-level highlight chips (`hlsearch` style).
6. **Fold system** — `h/l/↵` fold turns and tool groups, `Z` folds/unfolds all.
7. **Node preview** — `↵` on tree node opens its session in LEFT pane, `Esc`/`q` closes.
8. **Approval sheet** — borderless inline, `a/s/p/d` grants with reason typing.
9. **Queued messages** — `▸` list above input, `↑` pulls last back to edit.
10. **Running tool feed** — NodeDetail shows live tools for running agents (last 8).

---

## 2. agy (Antigravity CLI) UI Analysis

### Direct Observation (tmux capture)

From running `agy` in tmux with `--prompt-interactive`:

```
Accessing workspace:

/home/asiborro/Workspace/xandreed/tree/efferent

Do you trust the contents of this project?

Antigravity CLI requires permission to read, edit, and execute files here.

> Yes, I trust this folder
  No, exit

  ↑/↓ Navigate · enter Confirm
                                                         Gemini 3.5 Flash (High)
```

### agy Patterns Observed

| Pattern | agy Implementation | Our Status |
|---------|-------------------|------------|
| **Select lists** | `>` pointer + dim alternatives, footer `↑/↓ Navigate · enter Confirm` | ✅ Match |
| **Model badge** | Bottom-right model name (e.g. `Gemini 3.5 Flash (High)`) | ✅ We have roles row |
| **Contextual footer** | Keys as accent chips + dim labels, `·` separator | ✅ Match (`KeyHints`) |
| **Borderless** | No boxes, no surfaces, terminal background shows through | ✅ Match |
| **Inline menus** | Menus rise from the command line, not floating modals | ✅ Match (`BottomMenu`) |
| **Rule separators** | `─` rules around sections | ✅ Match (`InputFence`, `Rule`) |
| **Help on `?`** | Overlay reference card, not persistent footer | ✅ Match |
| **Two-stage Esc** | First Esc cancels queued, second interrupts | ✅ Match |
| **Tab focus cycle** | Input → chat → tree → input | ✅ Match |
| **Pane proportions** | agy uses **asymmetric split** — chat wider than side panel | ⚠️ We are 50/50 |

### Key agy Insight for Swarm

agy does NOT show a persistent fleet tree. It shows **agent activity inline** in the chat rail as "working on X" bubbles. For swarm orchestration, this is insufficient — you need to SEE the whole team.

Our split-pane approach (chat + fleet tree) is the **right architecture for swarm**. The gap is not the layout — it's how the **swarm data is surfaced and interacted with**.

---

## 3. Gap Analysis: From the Swarm Perspective

### 3.1 Broken / Non-Functional Commands

| Command | Current Behavior | Expected Behavior |
|---------|-----------------|-------------------|
| `:context` | Prints "deferred" info line | Should open context viewer in side pane |
| `:build` | Prints "deferred" info line | Should build new session from selected turns |
| `:sessions` | Prints info about `:browse` | Should show/manage all workspace sessions |
| `:traces` | Runs but may be stubbed | Should open traces in Grafana |
| `:dashboard` | Runs but may be stubbed | Should open fleet-health dashboard |

**Impact**: Context curation (`:context`/`:build`) is a core swarm feature — it lets the human curate what goes into the model's context window. Without it, context window management is opaque.

### 3.2 Missing Swarm-Orchestration UI

| Gap | Problem | agy Parallel |
|-----|---------|-------------|
| **No live agent output streaming** | AgentPane shows live log, but only when you ↵ into it. You can't watch ALL agents at once. | agy doesn't show agents at all |
| **No agent-to-agent messaging** | The fleet tree shows status but not inter-agent communication. | N/A |
| **Plan visibility is buried** | `update_plan` checklist is in NodeDetail (root only), not prominently shown. | agy has no plan concept |
| **No swarm-level decisions** | DecisionsBar shows `needs_human` events, but not WHICH agent needs what. | N/A |
| **Fleet header chip is static** | `◆ 2 agents · haiku, audit` — no live status of what they're doing. | N/A |
| **No visual agent assignment** | When you type with a node preview open, the `→ agent: name` suffix is subtle. | N/A |

### 3.3 Interaction Friction

| Issue | Detail |
|-------|--------|
| **50/50 split wastes space** | The fleet tree rarely needs half the screen. Chat should be wider (60/40 or 65/35). |
| **NodeDetail is below the tree** | When the tree is tall, the detail is pushed below the fold. Better: detail in a **collapsible section** or **inline** with the selected row. |
| **No agent progress bars** | Running agents show `● thinking…` but no sense of "how far along". The plan is the closest thing but it's not a progress bar. |
| **Esc behavior is complex** | 5 different Esc handlers (interrupt, cancel command, clear search, close preview, leave composer). Users often hit the wrong one. |
| **No visual handoff boundaries** | Checkpoints (`⟲ handoff from audit`) are muted lines. They should be more prominent — they're session boundaries. |
| **Context viewer (`:context`) missing** | The old TUI had a context viewer showing archived vs loaded segments. This was deferred and never restored. |

### 3.4 Missing Keyboard Commands

| Command | What It Should Do |
|---------|-------------------|
| `A` (shift+a) | **Approve all pending decisions** — when multiple agents are waiting |
| `S` (shift+s) | **Stop all fleet agents** — emergency halt |
| `R` (shift+r) | **Refresh fleet tree** — force reload (sometimes stale) |
| `P` (shift+p) | **Pause/resume agent** — temporarily pause a running agent |
| `m` in tree | **Message agent directly** — open preview + focus input (alias for `↵` + `i`) |
| `a` in tree | **Abort agent** — stop a specific running agent (vs `:stop <id>`) |
| `f` in tree | **Follow agent** — keep the node detail scrolled to its live output |
| `gg`/`G` in tree | Jump to top/bottom works, but no **visual feedback** (no scrollbar, no "top of tree" indicator) |

### 3.5 Visual Hierarchy Issues

| Issue | Current | Better |
|-------|---------|--------|
| **Running agent in tree** | `● haiku` (same dot as idle) | **Spinning dot** or **pulse** — `⣻ haiku` |
| **Error agent** | `✗ audit` (red) | Red + **bold** or **blinking** to draw attention |
| **Stale badge** | `stale` (yellow text) | `⚠ stale` with icon, or dim the whole row |
| **Active tag** | `◀ active` (magenta) | Could be more prominent — it's WHERE your messages go |
| **Tool output in rail** | Capped at 20 lines | Should have a **"show more"** action or expandable |
| **Conversation turns** | All same weight | Could use **subtle indentation** or **separator** between turns |

### 3.6 Status Bar Gaps

| Gap | Current | Better |
|-----|---------|--------|
| **No cost tracking** | `38k/200k` tokens | Add **$ cost estimate** or **cumulative spend** |
| **No time tracking** | Elapsed on loader only | Add **session duration** to status bar |
| **No file change count** | In NodeDetail only | Add **N files changed this session** |
| **Model badge is static** | Shows configured models | Should show **currently active model** for the running turn |

---

## 4. Concrete Improvement Plan

### P0 — Critical Swarm UX

1. **Restore `:context` / `:build`**
   - Wire `runCommand.ts:context/build` to `toggleContext` / `buildFromSelection`
   - Add context viewer rendering in the right pane (or as an overlay)
   - The `ContextRowData` + `buildContextRowsData` already exist in `presentation/contextView.ts` and `sidePane.ts`

2. **Asymmetric pane split (60/40)**
   - `App.tsx:84` — change `flexGrow: 1` → left pane `flexGrow: 3`, right pane `flexGrow: 2`
   - Or use `width` percentages: left `60%`, right `40%`

3. **Running agent animation in tree**
   - `ContextTree.tsx:Row` — when `status === "running"`, use `glyph.spinner[frame]` instead of static `●`
   - Needs a `createEffect` or memo that reads `store.spinner()`

4. **Simplified Esc behavior**
   - Consider a **mode indicator** (like vim's `-- INSERT --`) to make Esc behavior predictable
   - Or: unify to "Esc always cancels the most specific thing first"

### P1 — Swarm Visibility

5. **Fleet-level progress indicator**
   - New component: `FleetProgress` — a compact bar showing how many of N agents are done/running/error
   - Lives in the header or above the fleet tree

6. **Agent-to-agent handoff visualization**
   - When a checkpoint (`handoff`) happens, draw a **visual connector** between the source and target agents in the tree
   - Or: add a "handoffs" section to NodeDetail

7. **Prominent plan display**
   - Extract the plan from NodeDetail into a **dedicated mini-pane** above the fleet tree
   - Or: render plan steps as a **horizontal progress bar** in the header

8. **Cost/usage tracking in status bar**
   - Add `SessionStats.byRole` display to StatusBar row 2
   - Show `$` estimate (if we have pricing data)

### P2 — Interaction Polish

9. **Keyboard additions**
   - `A` — approve all pending decisions
   - `S` — stop all fleet agents
   - `a` in tree — abort selected running agent
   - `m` in tree — message selected agent (open preview + focus input)

10. **Tool output expansion**
    - Add `e` key in chat pane: **expand** the tool pill under cursor to full output
    - Add `e` again: **collapse** back to preview

11. **Visual separators between turns**
    - Add a thin `─` rule between conversation turns (not between body items within a turn)
    - Makes the turn boundary obvious

12. **NodeDetail collapsible**
    - Make the "selected" section collapsible with `h`/`l` or `Space`
    - When collapsed, show only a one-line summary

### P3 — Chrome Polish

13. **Session age in tree**
    - Show relative age ("2m ago", "1h ago") next to finished agents
    - Helps identify stale work

14. **Better error surfacing**
    - Error agents should flash or blink briefly when they error
    - Add an error count to the header fleet chip

15. **Model switch indicator**
    - When the model switches mid-session (e.g. handoff to code tier), flash a brief note
    - Currently only visible in status bar roles row

---

## 5. Implementation Priority

```
Week 1: P0 (context restore, asymmetric split, running animation, Esc simplification)
Week 2: P1 (fleet progress, handoff viz, plan display, cost tracking)
Week 3: P2 (keyboard additions, tool expansion, turn separators, collapsible detail)
Week 4: P3 (session age, error surfacing, model switch indicator)
```

---

## 6. Files to Touch

| File | Change |
|------|--------|
| `view/App.tsx` | Asymmetric split proportions |
| `view/panes/FleetTree.tsx` | Collapsible detail, plan mini-pane |
| `view/panes/side/ContextTree.tsx` | Running spinner, stale styling, active prominence |
| `view/panes/side/NodeDetail.tsx` | Collapsible, handoff connectors |
| `view/chrome/Header.tsx` | Fleet progress, error count |
| `view/chrome/StatusBar.tsx` | Cost tracking, session duration |
| `view/chrome/RunningLoader.tsx` | Maybe move to per-agent in tree |
| `keys/dispatch.ts` | New keys (A, S, a, m, e, R) |
| `commands/runCommand.ts` | Wire `:context`/`:build` to real actions |
| `presentation/sidePane.ts` | Tree nav for new keys |
| `presentation/shortcuts.ts` | Document new keys |
| `presentation/agentState.ts` | Fleet progress helper |
| `state/conversation.ts` | Tool expand state |

---

## 7. agy Comparison Summary

| Feature | agy | efferent (current) | Winner |
|---------|-----|-------------------|--------|
| Borderless design | ✅ | ✅ | Tie |
| Contextual menus | ✅ | ✅ | Tie |
| Fleet visibility | ❌ (none) | ✅ (always-on tree) | **efferent** |
| Agent detail | ❌ | ✅ (NodeDetail + live tools) | **efferent** |
| Plan tracking | ❌ | ✅ (update_plan checklist) | **efferent** |
| Context curation | ❌ | ⚠️ (deferred) | agy (neither works) |
| Cost tracking | ❌ | ⚠️ (byRole exists, not shown) | Tie |
| Keyboard density | Medium | High (vim-inspired) | **efferent** |
| Visual polish | High | Medium | agy |
| Swarm orchestration | None | Partial | **efferent** |

**Conclusion**: efferent has the better architecture for swarm (split pane + fleet tree). The gaps are in **restoring deferred features**, **polishing the swarm data presentation**, and **simplifying interactions**. agy's visual polish (asymmetric layout, cleaner focus cues, better animation) should be adopted.
