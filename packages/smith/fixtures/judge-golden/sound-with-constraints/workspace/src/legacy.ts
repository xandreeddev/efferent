// The 2024 exporter — kept as-is until the v2 migration (see docs/migration.md).
export const legacyExport = (rows: ReadonlyArray<string>): string => rows.join("\r\n")
