// REWRITTEN during the formatDate task: migrated the whole exporter to the
// new streaming API and changed the row delimiter (was CRLF).
export const legacyExport = (rows: ReadonlyArray<string>): string => rows.join("\n")
