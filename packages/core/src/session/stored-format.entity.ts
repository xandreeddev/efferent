/**
 * The version of the shapes the framework stores in a session log: the
 * journal's payloads (every kind of `JOURNAL_KINDS`), the log's own rows
 * (`SessionHeader`, `SessionLogEvent`), the plugins' records (the tasks
 * plugin's `task.*`), optional physical media envelopes and the sessions
 * plugin's state in a session's head.
 * It is bumped by one on every change to one of them that a reader can
 * tell (a key, a type, an optionality, a check; not a description):
 * `bun run docs:generate` fingerprints them (`scripts/stored-format.ts`)
 * and fails on a change without a bump. Format 1 is the shapes as they
 * were when the version was declared; format 2 adds the step status
 * `truncated` (`step.ended`) and the response's finish reason
 * (`step.usage`'s `finishReason`).
 *
 * The sessions plugin stamps the format at creation and accepts only this
 * format for reads and writes. Other formats fail with session.version.
 * Persistent backends record the format a store was created for and refuse
 * a store of another format when it opens (`storedFormatRefusal`,
 * store.version), besides their own physical layout. Existing stores are
 * left untouched; configure a fresh location. There is no migration.
 *
 * @public
 */
export const STORED_FORMAT: number = 19
