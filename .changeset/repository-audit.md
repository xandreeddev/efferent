---
"@xandreed/core": minor
---

Session stores must be fresh (file layout 2, SQLite schema 3, stored format 19; older stores are refused, never migrated), session log calls and turn records take owner- and incarnation-qualified `SessionRef`s, and standalone loops and custom registries wrap their toolkit with `prepareToolkit`.
