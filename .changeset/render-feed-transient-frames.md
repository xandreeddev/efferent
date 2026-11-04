---
"@xandreed/plugin-render": minor
---

A render feed carries live, non-durable frames beside its journal records: `RenderFeed.frames` takes an optional `live` stream, sent as `FeedTransient` frames after the ready frame, with no SSE `id` and no sequence, so they never move the resume cursor.
