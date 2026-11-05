---
"@xandreed/plugin-knowledge-postgres": patch
---

The PostgreSQL knowledge store fails with reason `Invalid`, and a message naming the cause and the fix, when the server lacks pgvector, the role may not create the extension or the `efferent_knowledge` schema, the role lacks a privilege on its tables, or the database's objects do not fit the layout; connection failures and deadlines stay `Unavailable` and concurrent writes `Conflict`.
