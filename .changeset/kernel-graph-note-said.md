---
"@xandreed/sdk": minor
---

The kernel's note of known links says, beside each link, how many turns said it and the day it was last said
(`e1: Ana works at Acme. (said 3 times, last 2025-05-03)`), under a first line that says so. `linksNote` now takes
one ordered list of said links (`SaidLink`, from `saidOf`) in place of links, and `saidText` gives a link's count
and day in the note's words. `withGraph` sends the links' said entries, best first.
