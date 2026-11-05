---
"@xandreed/plugin-render": minor
---

A render feed can start a client at cursor 0 from a snapshot folded at a head sequence and read only the journal kinds its projection uses: `RenderFeed.frames` takes `{ live, kinds, snapshot }` after the projection (`live` moves there from the fourth argument), `JournalTail.read` takes `kinds`, which `SessionsJournalTailLive` passes to `Sessions.read`, and `foldEqualsReplay` checks a fold against its projection.
