---
"@xandreed/sdk": minor
---

`@xandreed/sdk/kernel` gains a memory that connects (ADR 0019): links between things, stored by the model through `linkThings` as records of a graph session of their own, folded by `linksOf`, and sent for a request by `withGraph({ hops, limit, speaker? })`, which walks from what the question names and ranks each link by the path to it, so the link that answers comes first though it shares no word with the question. `questionOf` moves to the memory contract and is still exported from the kernel's entry.
