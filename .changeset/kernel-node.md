---
"@xandreed/sdk": minor
---

The kernel keeps journals on a disk: `@xandreed/sdk/kernel/node`, an entry for the ports that need a runtime's modules on Node 24 and Bun, holds `directoryJournal({ directory })` (one file per session, a line per event with its CRC-32, durable when an append returns, a torn last line never read) and `sqliteJournal({ path })` (one SQLite file, `bun:sqlite` on Bun and `node:sqlite` on Node). Each refuses a format it does not know and has one writer: its layer takes the store as it is built, fails with `JournalOpenFailed` while another live process holds it, and takes it over once that process is gone. `recoverTurns` closes every turn a dead writer left open, as `Abandoned`, so a process killed inside a turn no longer leaves its session busy (ADR 0024).
