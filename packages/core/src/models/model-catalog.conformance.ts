import { Effect, Option, Schema } from "effect"
import type { Context } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect } from "../conformance.functions.js"
import { ModelCatalogEntry } from "../domain/model-catalog.entity.js"
import { parseModelSelection } from "../domain/model-selection.entity.functions.js"
import type { ModelCatalog } from "../ports/model-catalog.port.js"

type Catalog = Context.Service.Shape<typeof ModelCatalog>

const isEntry = Schema.is(ModelCatalogEntry)

/**
 * The ModelCatalog contract: every entry is a `ModelCatalogEntry`, its
 * `selection` is `"<provider>:<modelId>"` of the entry's own `provider`, no
 * selection is listed twice, two lists with nothing changed between them
 * agree, and the selections in `includes` (the models a host expects this
 * catalog to offer) are listed. The kit only reads.
 */
export const modelCatalogConformance = (catalog: Catalog, options: { readonly includes?: ReadonlyArray<string> } = {}): ReadonlyArray<ConformanceCheck> => [
  check("every entry is a ModelCatalogEntry", "decode", () => Effect.gen(function* () {
    const invalid = (yield* catalog.list).filter((entry) => !isEntry(entry))
    yield* expect("decode", invalid.length === 0, `entries that do not decode: ${JSON.stringify(invalid.slice(0, 3))}`)
  })),
  check("every selection is \"<provider>:<modelId>\" of the entry's provider", "selection", () => Effect.gen(function* () {
    const wrong = (yield* catalog.list).filter((entry) => !Option.exists(parseModelSelection(entry.selection), (parsed) => parsed.provider === entry.provider))
    yield* expect("selection", wrong.length === 0, `selections that do not name their provider: ${wrong.slice(0, 3).map((entry) => `${entry.selection} (${entry.provider})`).join(", ")}`)
  })),
  check("no selection is listed twice", "unique", () => Effect.gen(function* () {
    const selections = (yield* catalog.list).map((entry) => entry.selection)
    const repeated = selections.filter((selection, index) => selections.indexOf(selection) !== index)
    yield* expect("unique", repeated.length === 0, `listed more than once: ${[...new Set(repeated)].slice(0, 3).join(", ")}`)
  })),
  check("two lists with nothing changed between them agree", "stable", () => Effect.gen(function* () {
    const first = JSON.stringify(yield* catalog.list)
    yield* expect("stable", JSON.stringify(yield* catalog.list) === first, "two lists differ")
  })),
  check("the selections the caller expects are listed", "includes", () => Effect.gen(function* () {
    const listed = new Set((yield* catalog.list).map((entry) => entry.selection))
    const missing = (options.includes ?? []).filter((selection) => !listed.has(selection))
    yield* expect("includes", missing.length === 0, `not listed: ${missing.join(", ")}`)
  })),
]
