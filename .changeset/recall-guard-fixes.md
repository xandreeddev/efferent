---
"@xandreed/core": patch
"@xandreed/plugin-memory-window": patch
"@xandreed/plugin-memory-summary": patch
---

`recall_context`'s guard keeps what it says. A `ResultShown` refusal no longer names an offset: it says what the result showed when the call was made and sends the model to the offset the result's shortened form shows when the reply is read, so it still leads to where the result's shown form ends after the window strategy spills the result again or gives it its compact view. An offset inside a page the turn already read is refused with that page's end, where only the page's own start was, in a reply that names no turn and so stays true when it is read in a later one. A model that steps forward inside a page it read repeats one progress signature, and the step loop's breaker stops it while six refused calls in a row fall inside that page (a stride of up to 1,333 characters). An offset below a page already read is still served a whole page, most of it shown, so a model that steps downward still ends at the step limit or fails with `context.budget`. A page counts as read only for the run that read it. The last sentence of the tool's description says a call for shown text can return no text, and the tool's declaration reserves 240 estimated tokens (202 in 0.21.0). The guard reads the turn's earlier recall inputs once per call.
