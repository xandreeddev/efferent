import { Context } from "effect"
import type { Effect } from "effect"
import type { TurnError } from "../session/sessions.entity.js"
import type { ModelRequestDraft, ModelRequestPatch } from "../turn/model-request-hook.entity.js"

/**
 * Host policy for one fresh prepared turn request. The application helper
 * validates and snapshots its patch before any context/header write.
 * `modelRequestHookConformance` proves that application edge, not host policy.
 * @public
 */
export class ModelRequestHook extends Context.Service<ModelRequestHook, {
  readonly prepare: (draft: ModelRequestDraft) => Effect.Effect<ModelRequestPatch, TurnError>
}>()("@xandreed/core/ModelRequestHook") {}
