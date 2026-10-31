/**
 * The version of the shapes the framework stores in a session log: the
 * journal's payloads (every kind of `JOURNAL_KINDS`), the log's own rows
 * (`SessionHeader`, `SessionLogEvent`), the plugins' records (the tasks
 * plugin's `task.*`) and the sessions plugin's state in a session's head.
 * It is bumped by one on every change to one of them that a reader can
 * tell (a key, a type, an optionality, a check; not a description):
 * `bun run docs:generate` fingerprints them (`scripts/stored-format.ts`)
 * and fails on a change without a bump. Format 1 is the shapes as they
 * were when the version was declared; format 2 adds the step status
 * `truncated` (`step.ended`) and the response's finish reason
 * (`step.usage`'s `finishReason`).
 *
 * The sessions plugin stamps a session with the format of the release that
 * last wrote it, and refuses to write to, or run a turn over, a session a
 * newer release stamped (`SessionLogError`, code `session.version`); reads
 * still work. A backend keeps its own marker for its own layout (the SQLite
 * log's `user_version`, `store.version`).
 *
 * @public
 */
export const STORED_FORMAT: number = 7
