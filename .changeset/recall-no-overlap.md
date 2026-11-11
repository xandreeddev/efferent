---
"@xandreed/core": patch
"@xandreed/plugin-memory-window": patch
"@xandreed/plugin-memory-summary": patch
---

A page `recall_context` serves never holds text of a page the same run already read in the turn: it ends where the next such page starts, wherever the call starts, so every character a call returns is new to the request and the pages of one result never hold more than the result does. A model that steps downward through a result, each call a little below the last page it read, is served only the text between, where 0.21.1 served a whole page each time and the run ended at the step limit or failed with `context.budget`. A page that stops at text already read ends with a line that says how far that text runs and names the offset past it (`[… the next N characters are in text you already read, shown above; M more characters after them; call recall_context with locator "…" and offset R]`), or `[… the remaining N characters are in text you already read, shown above]` when it runs to the result's end; the line of a page with unread text after it is unchanged, and so is the tool's description. A page already read is known by the text its call returned, so `AlreadyRecalled` names the end a cut page has, and a result of the tool that is not a page it writes (a host's own answer to the call) is no longer counted as read.
