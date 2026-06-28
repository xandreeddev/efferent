---
"@xandreed/sdk-adapters": patch
---

settings: a stray `null` on an optional field (e.g. `codeModel: null`) no longer discards the ENTIRE config.

The settings schema accepts `string | undefined`, never `null`, so a single null field failed validation and the loader dropped the whole local config — silently falling back to global defaults. In practice this disabled the configured code tier (so coding never delegated — the "fleet never fires" report) and reset every other setting (the "everything is deepseek" report). The loader now treats a top-level `null` as "unset", so one cleared field can't nuke the rest.
