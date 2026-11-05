---
"@xandreed/plugin-render": minor
---

`SseTransport` ends its peer through the new `SsePeer.end` when the frames end, and `sseNodePeer` takes `{ compress }`, the request's `Accept-Encoding`, to send the feed in Brotli or gzip with a flush after every write.
