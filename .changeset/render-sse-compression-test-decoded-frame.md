---
---

Test change only, no release: `@xandreed/plugin-render`'s test that a compressed SSE frame reaches the client while the stream stays open waits for the frame's decoded bytes through streaming Brotli and gzip decoders, with a stated deadline, instead of decompressing the whole body on every chunk until the test runner's timeout.
