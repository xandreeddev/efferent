---
"@xandreed/plugin-render": minor
---

A render feed follows its `live` stream before it folds a snapshot or reads the backlog and holds its payloads until the ready frame, so a payload published while a cold client catches up (a turn's deltas for a client connecting mid-turn) reaches it after `ready`, in order. `FeedFramesOptions.liveBuffer` (256 by default) bounds what waits: at the bound the feed pulls no more from `live` until the client takes some, so a pull-based or finite source still loses nothing and a session channel drops at its own capacity, as before; `renderFeedConformance` checks a live payload published during the snapshot's fold and a finite live stream longer than the bound.
