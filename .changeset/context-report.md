---
"@xandreed/core": minor
---

`contextReportOf(events, { largest })` reports what filled each model request of a session from its journal alone: a row per `request.prepared` (a resend is its own row) with the characters and tokens of the system text and of the tool declarations, which sum to the request's reserved tokens, the strategy's estimate, the budget, the tool results shown, a request hook's note and the step policy's step context in separate fields, and the usage the provider reported; and per turn the largest tool results with how each was shown (`whole`, `compact`, `digest`, `bounded` or `spilled`) and whether the tool's own view or the raw JSON wrote the text.
