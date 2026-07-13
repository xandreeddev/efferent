import { Context, Effect } from "effect"
import type { UiComponentAdmission, UiComponentDefinition, UiComponentUsage } from "../domain/ui-component.entity.js"

export interface UiComponentCatalogService {
  readonly list: Effect.Effect<ReadonlyArray<UiComponentDefinition>, string>
  readonly admit: (definition: UiComponentDefinition) => Effect.Effect<UiComponentAdmission, string>
  readonly recordUsage: (usage: UiComponentUsage) => Effect.Effect<void, string>
  readonly usages: (componentId: string) => Effect.Effect<ReadonlyArray<UiComponentUsage>, string>
}

export class UiComponentCatalog extends Context.Tag("@xandreed/ui-agent/UiComponentCatalog")<UiComponentCatalog, UiComponentCatalogService>() {}
