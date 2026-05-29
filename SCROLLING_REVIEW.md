# TUI Scrolling Implementation Review

An architectural and usability review of the terminal scrolling engine inside the coding agent.

---

## 1. Architecture Overview

The TUI scrolling implementation is a custom, hand-rolled solution built on **Bun + Raw ANSI escape sequences**, entirely bypassing heavy visual libraries like `blessed` or `Ink`.

The core responsibility is split across three packages:
1. **`packages/cli/src/tui/scrollback.ts`**: Manages the `Scrollback` state class, line limits, and raw block formatting (User, Assistant, Tool, Info, Error).
2. **`packages/cli/src/tui/render.ts`**: Composites the full terminal screen layout by calculating dynamic viewport allocations across status, scrollback, palette, and input regions.
3. **`packages/cli/src/modes/tui.ts` & `packages/cli/src/tui/keys.ts`**: Connect input streams (such as Page Up/Down keys and SGR mouse reporting) to scroll mutations.

---

## 2. Key Strengths & Elegant Solutions

* **Decoupled Viewport Math:** `Scrollback` maintains state using a relative `scrollOffset` (measured in visual lines relative to the bottom) rather than hardcoded block indices. This ensures terminal resizing or side-pane toggles naturally adjust visual boundaries without crashing.
* **Background Streaming Stability:** When agent streaming events or tool executions occur, the viewport stays frozen if the user is currently scrolling (`scrollOffset > 0`). It never forcibly "yanks" the cursor back to the bottom unless explicitly triggered by a user submission.
* **Compact Navigation Pills:** Navigational tools (`ls`, `glob`, `read`, `grep`) stay compact, while full command outputs (`bash`, `unifiedDiff`) can be collapsed or fully expanded on demand (`Ctrl-R`), preventing buffer overflow.

---

## 3. Identified Bugs & Usability Issues

### A. Scroll Direction Indicator Bug (Visual Correction)
* **Location:** `packages/cli/src/tui/scrollback.ts:270-276`
* **Symptom:** When a user scrolls up (`this.scrollOffset > 0`), the new content is hidden *below* the viewport. However, the top row is replaced with a banner showing an **up** arrow (`↑`):
  ```typescript
  if (this.scrollOffset > 0) {
    const indicator = `${ansi.dim}${ansi.fgYellow}↑ ${this.scrollOffset} more · PgDn to follow${ansi.reset}`
    window[0] = indicator
  }
  ```
  This is confusing because the hidden content referenced by `scrollOffset` is located at the **bottom** of the viewport, not the top.
* **Impact:** Users are misdirected as to where the unread content lies. Additionally, if there are *also* older lines hidden above the viewport (`start > 0`), that indicator is completely overwritten and lost.

### B. Rigid & Slow Scroll Step on Large Terminals
* **Location:** `packages/cli/src/modes/tui.ts:988-1019`
* **Symptom:** Scroll steps are hardcoded to `5` lines for PageUp/PageDown, and `3` lines for mouse wheels.
* **Impact:** For a standard screen with 40–80 visual lines, scrolling through a 500-line tool output or long conversation feels incredibly sluggish and unresponsive.

### C. Performance: Re-rendering All Blocks O(N) on Every Frame
* **Location:** `packages/cli/src/tui/scrollback.ts:243-255`
* **Symptom:** For every keystroke, spinner frame, or streamed token, `Scrollback.render` rebuilds the entire visual line buffer from scratch, re-parsing markdown, wrapping lines, and regenerating diffs.
* **Impact:** As the session history grows, input latency will degrade. Since blocks are mostly append-only, re-evaluating the full history on every frame is highly inefficient.

---

## 4. Architectural Recommendations

### Recommendation 1: Align Directional Arrows
Fix the arrow misalignment by showing the upward-indicator at the top and the downward-indicator at the bottom of the viewport:
```typescript
// packages/cli/src/tui/scrollback.ts

// 1. Show lines hidden above at the top row
if (start > 0) {
  window[0] = `${ansi.dim}↑ ${start} more above${ansi.reset}`
}

// 2. Show lines hidden below at the bottom row
if (this.scrollOffset > 0) {
  window[window.length - 1] = `${ansi.dim}${ansi.fgYellow}↓ ${this.scrollOffset} more below · PgDn to follow${ansi.reset}`
}
```

### Recommendation 2: Responsive Scroll Steps
Inject the dynamic viewport height (`middleRows`) into the key handlers so that Page Up/Down behaves as a true "Page" action:
```typescript
// packages/cli/src/modes/tui.ts
const pageStep = Math.max(5, Math.floor(middleRows * 0.75))

if (key.type === "pageUp") {
  st.scrollback.scrollBy(pageStep)
} else if (key.type === "pageDown") {
  st.scrollback.scrollBy(-pageStep)
}
```

### Recommendation 3: Memoized Block Lines
Introduce a simple caching layer inside the `Scrollback` class (or on individual `ScrollbackBlock` instances) to store pre-wrapped and pre-colorized visual lines, invalidated only when `cols` or `expanded` state changes:
```typescript
interface CacheKey {
  cols: number
  expanded: boolean
}

// Inside ScrollbackBlock/Scrollback
// Cache rendered visual line chunks to keep keypress processing at 0ms.
```

---

## 5. Resolution (2026-05-29)

All three findings are addressed in `packages/cli/src/tui/scrollback.ts`:

- **A — directional arrows:** `render()` now sets `↑ N above` on the top row (when `start > 0`)
  and `↓ N below · PgDn to follow` on the bottom row (when `scrollOffset > 0`), independently —
  no more wrong-direction arrow or clobbered "above" indicator.
- **B — responsive step:** page keys use `max(5, floor(viewportRows * 0.75))` (`pageUp`/`pageDown`),
  with `Ctrl-D/U` half-page (`floor(rows/2)`) and `j/k` single-line.
- **C — memoized blocks:** per-block wrapped lines are cached in a `WeakMap` keyed by block identity
  (+ cols + expanded); `flatten()` concatenates cached arrays, so a keystroke/spinner tick no longer
  re-wraps the whole history. A tool-pill update swaps the block object, invalidating just that entry.

This landed alongside the larger vim-modal TUI work (focusable panes, `/` search reusing the same
flattened lines, VISUAL-mode yank). See `packages/cli/SCOPE.md` → "TUI invariants".
