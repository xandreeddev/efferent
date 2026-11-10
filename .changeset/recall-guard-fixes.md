---
"@xandreed/core": patch
"@xandreed/plugin-memory-window": patch
"@xandreed/plugin-memory-summary": patch
---

`recall_context`'s guard keeps what it says. A `ResultShown` refusal no longer names an offset: it says what the result showed when the call was made and sends the model to the offset the result's shortened form shows when the reply is read, so it still leads to the first unread text after the window strategy spills the result again or gives it its compact view. An offset inside a page the turn already read is refused with that page's end, where only the page's own start was, so a model that steps inside a page repeats one progress signature and the step loop's breaker stops it. A page counts as read only for the run that read it. The last sentence of the tool's description says a call for shown text can return no text, and the tool's declaration reserves 240 estimated tokens (202 in 0.21.0). The guard reads the turn's earlier recall inputs once per call.
