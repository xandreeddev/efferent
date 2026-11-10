---
"@xandreed/core": minor
"@xandreed/plugin-memory-window": minor
"@xandreed/plugin-memory-summary": minor
"@xandreed/plugin-tool-discovery": minor
"@xandreed/plugin-workspace": minor
"@xandreed/plugin-rag": minor
"@xandreed/plugin-memory": minor
---

Both memory strategies bound a tool result as it is written (`boundOnWriteChars`, 16,000 characters by default, `0` off): a longer result is shown from its first request as its first characters and a `recall_context` locator, while the stored result stays whole. A tool sets its own bound with the `boundOnWriteChars` annotation (`0` keeps its results whole, as the workspace tools `read`, `ls`, `find`, `grep` and `bash`, `read_knowledge` and `read_memory` do). The window strategy is version 3 and spills a bounded result again only under pressure, largest shown first; the summary plugin contributes `recall_context`, whatever its bound is. The preview and a `recall_context` page never end inside a surrogate pair, `defineTool` checks the annotation, and `rewrittenBy` is removed from `@xandreed/core` in favour of `shownViewsOf`.
