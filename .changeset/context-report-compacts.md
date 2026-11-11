---
"@xandreed/core": patch
---

The turn summaries of `contextReportOf` count the compact views memory recorded during the turn, as `compacts`: one for each result a `CompactViews` compaction names, at the turn's start or once a request passed its budget. A turn that compacted an earlier result under pressure listed it `whole`, as its first request had shown it, with every count at 0; it now counts the compact view. `compacts` is a required key of `ContextReportTurn`, so a report a host kept from 0.21.0 no longer decodes with the schema, and it counts every compact view recorded in the turn, whatever strategy recorded it and whether or not a request showed the result through it. A result is still listed at the largest size a request of the turn showed it, labelled as that request showed it: `whole` in the turn that compacted it after showing it whole, `compact` in a turn whose requests never showed it larger.
