---
"@xandreed/core": patch
"@xandreed/plugin-memory-window": patch
"@xandreed/plugin-memory-summary": patch
---

`recall_context` reads a page already read from what the request shows for its call's result, not from the value the call returned: a page a registry or a host presents as other text is no longer counted as read, so a call for its text is served. A locator that holds the characters a page's last line starts with (a run id is any string) no longer hides its pages from the guard.
