---
"@xandreed/core": minor
"@xandreed/plugin-sessions": minor
"@xandreed/plugin-session-files": minor
"@xandreed/plugin-session-sqlite": minor
---

A session read can take its limit from the end: `SessionReadQuery.from: "end"` (and `Sessions.read`'s `from`) returns the newest `limit` events of the given kinds, at most `through` and after `after`, still in ascending order, so a host that needs a session's latest records of a few kinds no longer reads and folds the whole journal. Every backend serves it (in memory, the media-store decorator, the file log newest commit first, SQLite along its indexes); `sessionLogConformance` and `sessionsConformance` check it (`read-latest`). Omitting `from` reads from the start, as before.
