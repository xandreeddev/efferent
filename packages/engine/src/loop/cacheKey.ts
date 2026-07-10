import { FiberRef, GlobalValue, Option } from "effect"

/**
 * The CURRENT conversation's cache identity, stamped by `runAgent` for the
 * duration of a run. Adapters that can key server-side prompt caches on a
 * stable id (OpenAI-compatible `prompt_cache_key`) read it at call time —
 * one conversation, one cache lane, so parallel sessions stop evicting
 * each other's prefixes. `None` (the default) sends nothing.
 *
 * A FiberRef, not a port: it's ambient call metadata, not a capability —
 * and it must flow through the loop's fibers without threading a parameter
 * through every seam.
 */
export const CurrentPromptCacheKey = GlobalValue.globalValue(
  "@xandreed/engine/CurrentPromptCacheKey",
  () => FiberRef.unsafeMake(Option.none<string>()),
)
