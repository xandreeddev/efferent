import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Either, Layer, Schema } from "effect"
import { CORE_UI_COMPONENTS, UiComponentCatalog, UiComponentDefinition, admitComponent, normalizeComponentDefinition, validateComponentDefinition } from "@xandreed/ui-agent"
import type { UiComponentAdmissionType, UiComponentDefinitionType, UiComponentUsageType } from "@xandreed/ui-agent"

const decodeDefinition = Schema.decodeUnknownEither(Schema.parseJson(UiComponentDefinition))

const decodeRows = (rows: ReadonlyArray<{ readonly definition: string }>): ReadonlyArray<UiComponentDefinitionType> => rows.flatMap((row) => Either.match(decodeDefinition(row.definition), {
  onLeft: () => [],
  onRight: (definition) => [definition],
}))

const uniqueAdmission = (
  admission: UiComponentAdmissionType,
  existing: ReadonlyArray<UiComponentDefinitionType>,
): UiComponentAdmissionType => {
  if (admission.disposition !== "admitted" || !existing.some((definition) => definition.id === admission.definition.id)) return admission
  const id = `workspace.${admission.definition.id.replace(/^workspace\./, "")}-${admission.definition.fingerprint?.slice(-6) ?? "custom"}`
  return { ...admission, canonicalId: id, definition: { ...admission.definition, id } }
}

export const SqliteUiComponentCatalogLive = (dbPath: string) => Layer.scoped(
  UiComponentCatalog,
  Effect.gen(function* () {
    const db = yield* Effect.try({
      try: () => {
        mkdirSync(dirname(dbPath), { recursive: true })
        const database = new Database(dbPath, { create: true })
        chmodSync(dbPath, 0o600)
        database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;")
        database.exec(`CREATE TABLE IF NOT EXISTS ui_components (
          id TEXT PRIMARY KEY,
          version TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          status TEXT NOT NULL,
          definition TEXT NOT NULL,
          created_at INTEGER NOT NULL
        ); CREATE INDEX IF NOT EXISTS ui_components_by_fingerprint ON ui_components(fingerprint);
        CREATE TABLE IF NOT EXISTS ui_component_usage (
          component_id TEXT NOT NULL,
          page_id TEXT NOT NULL,
          intent TEXT NOT NULL,
          rendered_at INTEGER NOT NULL
        ); CREATE INDEX IF NOT EXISTS ui_component_usage_by_component ON ui_component_usage(component_id, rendered_at);`)
        return database
      },
      catch: (error) => `ui-component-catalog: ${String(error)}`,
    })
    yield* Effect.addFinalizer(() => Effect.try({
      try: () => db.close(),
      catch: (error) => error,
    }).pipe(
      Effect.catchAll((error) => Effect.logWarning(`UI component database cleanup failed: ${String(error)}`)),
    ))

    const workspace = Effect.try({
      try: () => decodeRows(db.query("SELECT definition FROM ui_components WHERE status != 'deprecated' ORDER BY id").all() as ReadonlyArray<{ readonly definition: string }>),
      catch: (error) => `ui-component-catalog: ${String(error)}`,
    })
    const list = workspace.pipe(Effect.map((definitions) => [...CORE_UI_COMPONENTS.map(normalizeComponentDefinition), ...definitions]))

    return {
      list,
      admit: (candidate: UiComponentDefinitionType) => Effect.gen(function* () {
        const findings = validateComponentDefinition(candidate)
        if (findings.length > 0) return yield* Effect.fail(findings.join("; "))
        const definitions = yield* list
        const admission = uniqueAdmission(admitComponent(candidate, definitions), definitions)
        if (admission.disposition !== "admitted") return admission
        yield* Effect.try({
          try: () => db.query("INSERT INTO ui_components(id, version, fingerprint, status, definition, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").run(
            admission.definition.id,
            admission.definition.version,
            admission.definition.fingerprint ?? "",
            admission.definition.status,
            JSON.stringify(admission.definition),
            admission.definition.createdAt,
          ),
          catch: (error) => `ui-component-catalog: ${String(error)}`,
        })
        return admission
      }),
      recordUsage: (usage: UiComponentUsageType) => Effect.try({
        try: () => void db.query("INSERT INTO ui_component_usage(component_id, page_id, intent, rendered_at) VALUES (?1, ?2, ?3, ?4)").run(usage.componentId, usage.pageId, usage.intent, usage.renderedAt),
        catch: (error) => `ui-component-catalog: ${String(error)}`,
      }),
      usages: (componentId: string) => Effect.try({
        try: () => db.query("SELECT component_id AS componentId, page_id AS pageId, intent, rendered_at AS renderedAt FROM ui_component_usage WHERE component_id = ? ORDER BY rendered_at").all(componentId) as ReadonlyArray<UiComponentUsageType>,
        catch: (error) => `ui-component-catalog: ${String(error)}`,
      }),
    }
  }),
)
