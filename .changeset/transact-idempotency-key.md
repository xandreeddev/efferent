---
"@xandreed/core": minor
"@xandreed/plugin-sessions": minor
---

`Sessions.transact(address, decide, { key, command })` is idempotent by an optional key: the commit that records the decision stores the key and its command (`transact.keyed`, stored format 18), and a later transact under the key calls no `decide`, writes nothing and fails with `TransactDuplicate` (the first one's events) or, with another command, `TransactConflict`. Racing retries commit once; transact keys are apart from turn keys. `sessionsConformance` checks a retried key, a conflicting retry and racing retries.
