import { Context } from "effect"
import type { Effect, Option, Scope } from "effect"
import type { Manager } from "./repo-profile.entity.js"
import type { CacheUnavailable, SnapshotKey, Verdict, VerdictKey } from "./review-cache.entity.js"
import type { RepoName } from "./pull-request.entity.js"

/**
 * What the reviewer keeps between reviews of a repository, in folders it owns (never the host's own caches):
 * `verdict` and `remember`, what a command did on the base, by `VerdictKey`; `packages`, the bot's package cache of a manager, bound into an install; `scratch`, a
 * folder of its own for the scope, deleted after (a head's package cache when it changes the registry's config);
 * `snapshot`, an installed `node_modules` kept by its key; `saving`, a folder to save one into, published under the
 * key by `commit` and deleted with the scope otherwise.
 */
export class ReviewCache extends Context.Service<ReviewCache, {
  readonly verdict: (key: VerdictKey) => Effect.Effect<Option.Option<Verdict>>
  readonly remember: (key: VerdictKey, verdict: Verdict) => Effect.Effect<void, CacheUnavailable>
  readonly packages: (repo: RepoName, manager: Manager) => Effect.Effect<string, CacheUnavailable>
  readonly scratch: (repo: RepoName) => Effect.Effect<string, CacheUnavailable, Scope.Scope>
  readonly snapshot: (key: SnapshotKey) => Effect.Effect<Option.Option<string>>
  readonly saving: (key: SnapshotKey) => Effect.Effect<{ readonly dir: string; readonly commit: Effect.Effect<void, CacheUnavailable> }, CacheUnavailable, Scope.Scope>
}>()("@xandreed/review/ReviewCache") {}
