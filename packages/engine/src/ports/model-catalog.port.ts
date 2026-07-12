import { Context } from "effect"
import type { Effect } from "effect"
import type { ModelCatalogEntry } from "../domain/model-catalog.entity.js"

/** Provider-neutral discovery of models usable by configured adapters. */
export class ModelCatalog extends Context.Tag("@xandreed/engine/ModelCatalog")<
  ModelCatalog,
  { readonly list: Effect.Effect<ReadonlyArray<ModelCatalogEntry>> }
>() {}
