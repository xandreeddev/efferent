import { Effect, Match, Option, Order, Schema } from "effect"
import {
  KnowledgeAssertion, KnowledgeChunk, KnowledgeEmbeddingSpace, KnowledgeEntity, KnowledgeError,
  KnowledgeJob, KnowledgeMemory, KnowledgeSource, sameEmbeddingSpace, validateKnowledgeStage,
} from "@xandreed/core"
import type {
  KnowledgeCandidate, KnowledgeCandidates, KnowledgeIndex, KnowledgeLease,
  KnowledgeScope, KnowledgeSnapshot, KnowledgeSourceRef, KnowledgeStage, KnowledgeSubgraph,
  KnowledgeTraversal, KnowledgeVector,
} from "@xandreed/core"
import type { PostgresDatabase, PostgresQueries } from "./postgres-connection.adapter.js"

type Domain = "memory" | "knowledge"
type Parameters = ReadonlyArray<string | number | boolean | null>
const WHERE = "domain = $1 AND owner = $2 AND namespace = $3 AND collection = $4"
const KEY = "domain, owner, namespace, collection"
const lexicalQuery = (parameter: number): string => `to_tsquery('simple',replace(plainto_tsquery('simple',$${parameter})::text,' & ',' | '))`
const params = (domain: Domain, scope: KnowledgeScope): Parameters => [domain, scope.owner, scope.namespace, scope.collection]
const invalid = (reason: KnowledgeError["reason"], message: string) => Effect.fail(new KnowledgeError({ reason, message }))
const encode = <A, I>(schema: Schema.Codec<A, I>, value: A): Effect.Effect<string, KnowledgeError> =>
  Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
    Effect.mapError((cause) => new KnowledgeError({ reason: "Invalid", message: "the knowledge value cannot be stored", cause })),
  )
const strings = (values: ReadonlyArray<string>) => encode(Schema.Array(Schema.String), values)
const payloads = <A, I>(db: PostgresQueries, schema: Schema.Codec<A, I>, statement: string, values: Parameters): Effect.Effect<ReadonlyArray<A>, KnowledgeError> =>
  db.rows(Schema.Struct({ payload: schema }), statement, values).pipe(Effect.map((rows) => rows.map((row) => row.payload)))

const Head = Schema.Struct({ accepted_revision: Schema.Number, published_revision: Schema.NullOr(Schema.Number), tombstone_at: Schema.NullOr(Schema.Number) })
const ScopeRow = Schema.Struct({ version: Schema.Number, embedding_profile: Schema.NullOr(KnowledgeEmbeddingSpace) })
const CountRow = Schema.Struct({ count: Schema.Number })
const IdentityRow = Schema.Struct({ source_id: Schema.String, source_revision: Schema.Number })
const IdRow = Schema.Struct({ id: Schema.String })
const memoryScore = Schema.Struct({ payload: KnowledgeMemory, score: Schema.Number })
const chunkScore = Schema.Struct({ payload: KnowledgeChunk, score: Schema.Number })
const vectorText = (vector: KnowledgeVector): string => `[${vector.values.join(",")}]`
const nullable = <A>(value: Option.Option<A>): A | null => Option.getOrNull(value)

/** Independent logical indexes share one physical schema and pool. */
export const makePostgresIndex = (db: PostgresDatabase, domain: Domain): KnowledgeIndex => {
  const ensureScope = (tx: PostgresQueries, scope: KnowledgeScope) => tx.execute(`INSERT INTO efferent_knowledge.scopes (${KEY}) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, params(domain, scope))
  const lockScope = (tx: PostgresQueries, scope: KnowledgeScope) => ensureScope(tx, scope).pipe(Effect.andThen(
    tx.rows(ScopeRow, `SELECT version::float8 AS version, embedding_profile FROM efferent_knowledge.scopes WHERE ${WHERE} FOR UPDATE`, params(domain, scope)),
  ), Effect.flatMap((rows) => rows[0] ? Effect.succeed(rows[0]) : invalid("Corrupt", "the knowledge scope disappeared")))
  const head = (tx: PostgresQueries, scope: KnowledgeScope, id: string) => tx.rows(Head,
    `SELECT accepted_revision::float8 AS accepted_revision, published_revision::float8 AS published_revision, tombstone_at::float8 AS tombstone_at FROM efferent_knowledge.heads WHERE ${WHERE} AND source_id = $5`, [...params(domain, scope), id],
  ).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))
  const status = (tx: PostgresQueries, scope: KnowledgeScope, id: string, lock = false) => payloads(tx, KnowledgeJob,
    `SELECT payload FROM efferent_knowledge.jobs WHERE ${WHERE} AND id = $5${lock ? " FOR UPDATE" : ""}`, [...params(domain, scope), id],
  ).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))
  const saveJob = (tx: PostgresQueries, job: KnowledgeJob) => Effect.gen(function* () {
    const data = yield* encode(KnowledgeJob, job)
    const lease = Match.valueTags(job.phase, {
      Processing: (phase) => ({ token: phase.token, until: phase.leaseUntil }),
      Queued: () => ({ token: null, until: null }), Failed: () => ({ token: null, until: null }),
      Complete: () => ({ token: null, until: null }), Cancelled: () => ({ token: null, until: null }),
    })
    yield* tx.execute(`INSERT INTO efferent_knowledge.jobs (${KEY}, id, source_id, source_revision, engine, phase, lease_token, lease_until, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text::jsonb)
      ON CONFLICT (${KEY}, id) DO UPDATE SET phase=EXCLUDED.phase, lease_token=EXCLUDED.lease_token, lease_until=EXCLUDED.lease_until, payload=EXCLUDED.payload`,
    [...params(domain, job.scope), job.id, job.source.id, job.source.revision, job.engine, job.phase._tag, lease.token, lease.until, data])
  })
  const sources = (tx: PostgresQueries, scope: KnowledgeScope) => payloads(tx, KnowledgeSource,
    `SELECT s.payload FROM efferent_knowledge.sources s JOIN efferent_knowledge.heads h USING (${KEY}, source_id)
      WHERE s.domain=$1 AND s.owner=$2 AND s.namespace=$3 AND s.collection=$4 AND h.tombstone_at IS NULL ORDER BY s.source_id,s.revision`, params(domain, scope))
  const snapshot = (tx: PostgresQueries, scope: KnowledgeScope): Effect.Effect<KnowledgeSnapshot, KnowledgeError> => Effect.gen(function* () {
    const scopeRows = yield* tx.rows(ScopeRow, `SELECT version::float8 AS version, embedding_profile FROM efferent_knowledge.scopes WHERE ${WHERE}`, params(domain, scope))
    const memories = yield* payloads(tx, KnowledgeMemory, `SELECT payload FROM efferent_knowledge.memories WHERE ${WHERE} AND NOT invalidated ORDER BY id`, params(domain, scope))
    const entities = yield* payloads(tx, KnowledgeEntity, `SELECT payload FROM efferent_knowledge.entities WHERE ${WHERE} ORDER BY id`, params(domain, scope))
    const assertions = yield* payloads(tx, KnowledgeAssertion, `SELECT payload FROM efferent_knowledge.assertions WHERE ${WHERE} AND NOT invalidated ORDER BY id`, params(domain, scope))
    return { version: scopeRows[0]?.version ?? 0, memories, graph: { entities, assertions, truncated: false } }
  })
  const leased = (tx: PostgresQueries, lease: KnowledgeLease): Effect.Effect<KnowledgeJob, KnowledgeError> => Effect.gen(function* () {
    const found = yield* status(tx, lease.scope, lease.jobId, true)
    if (Option.isNone(found)) return yield* invalid("LeaseLost", "the knowledge job does not exist")
    const job = found.value
    const owns = Match.valueTags(job.phase, {
      Processing: (phase) => phase.token === lease.token && phase.leaseUntil > lease.now,
      Queued: () => false, Complete: () => false, Cancelled: () => false, Failed: () => false,
    })
    if (!owns) return yield* invalid("LeaseLost", "the knowledge job lease has expired or changed")
    const current = yield* head(tx, lease.scope, job.source.id)
    if (Option.isNone(current) || current.value.tombstone_at !== null) return yield* invalid("Tombstoned", "the knowledge source has been forgotten")
    if (current.value.accepted_revision !== job.source.revision) return yield* invalid("Conflict", "a newer source revision superseded this job")
    return job
  })
  const validateStage = (tx: PostgresQueries, lease: KnowledgeLease, stage: KnowledgeStage) => Effect.gen(function* () {
    const state = yield* snapshot(tx, lease.scope)
    if (state.version !== stage.expectedVersion) return yield* invalid("Conflict", "the knowledge graph changed after extraction")
    const originals = yield* sources(tx, lease.scope)
    const refusal = validateKnowledgeStage(stage, state, originals)
    if (Option.isSome(refusal)) return yield* Effect.fail(refusal.value)
    const vectors = [...stage.memories, ...stage.chunks].flatMap((item) => Option.toArray(item.embedding))
    const scope = yield* tx.rows(ScopeRow, `SELECT version::float8 AS version, embedding_profile FROM efferent_knowledge.scopes WHERE ${WHERE}`, params(domain, lease.scope))
    const profile = scope[0]?.embedding_profile
    const badVector = vectors.some((vector) => vector.values.length !== vector.space.dimensions || vector.space.dimensions > 16_000 || !vector.values.every(Number.isFinite) || (profile !== null && profile !== undefined && !sameEmbeddingSpace(profile, vector.space)))
    if (badVector) return yield* invalid("EmbeddingMismatch", "the embedding identity or dimensions differ from the stored index")
    return vectors[0]?.space
  })
  const recordSources = (tx: PostgresQueries, scope: KnowledgeScope, kind: string, id: string, spans: ReadonlyArray<{ readonly source: KnowledgeSourceRef }>) =>
    Effect.forEach(spans, (span) => tx.execute(`INSERT INTO efferent_knowledge.record_sources (${KEY},kind,record_id,source_id,source_revision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [...params(domain, scope), kind, id, span.source.id, span.source.revision]), { concurrency: 1 }).pipe(Effect.asVoid)
  const insertMemory = (tx: PostgresQueries, scope: KnowledgeScope, memory: KnowledgeMemory) => Effect.gen(function* () {
    const data = yield* encode(KnowledgeMemory, memory)
    yield* tx.execute(`INSERT INTO efferent_knowledge.memories (${KEY},id,text,payload,embedding,known_from,known_to)
      VALUES ($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8::vector,$9,$10)`,
    [...params(domain, scope), memory.id, memory.text, data, Option.match(memory.embedding, { onNone: () => null, onSome: vectorText }), memory.knownFrom, nullable(memory.knownTo)])
    yield* recordSources(tx, scope, "memory", memory.id, memory.provenance)
    yield* Match.valueTags(memory.evidence, {
      Stated: () => Effect.void,
      Inferred: ({ supports }) => Effect.forEach(supports, (id) => tx.execute(`INSERT INTO efferent_knowledge.memory_supports (${KEY},memory_id,support_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [...params(domain, scope), memory.id, id]), { concurrency: 1 }).pipe(Effect.asVoid),
    })
  })
  const insertChunk = (tx: PostgresQueries, scope: KnowledgeScope, chunk: KnowledgeChunk) => Effect.gen(function* () {
    if (chunk.text !== chunk.provenance.quote) return yield* invalid("Invalid", "a retrieved chunk must equal its exact source quote")
    const data = yield* encode(KnowledgeChunk, chunk)
    yield* tx.execute(`INSERT INTO efferent_knowledge.chunks (${KEY},id,source_id,source_revision,text,payload,embedding)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text::jsonb,$10::vector)`,
    [...params(domain, scope), chunk.id, chunk.provenance.source.id, chunk.provenance.source.revision, chunk.text, data, Option.match(chunk.embedding, { onNone: () => null, onSome: vectorText })])
  })
  const insertEntity = (tx: PostgresQueries, scope: KnowledgeScope, entity: KnowledgeEntity) => Effect.gen(function* () {
    const existing = yield* payloads(tx, KnowledgeEntity, `SELECT payload FROM efferent_knowledge.entities WHERE ${WHERE} AND id=$5`, [...params(domain, scope), entity.id])
    const prior = existing[0]
    if (prior && (prior.name !== entity.name || prior.type !== entity.type)) return yield* invalid("Conflict", "an entity identity already names another entity")
    const aliases = [...new Set([...(prior?.aliases ?? []), ...entity.aliases])].toSorted(Order.String)
    const provenance = [...(prior?.provenance ?? []), ...entity.provenance].filter((span, index, all) => all.findIndex((other) => other.source.id === span.source.id && other.source.revision === span.source.revision && other.start === span.start && other.end === span.end && other.quote === span.quote) === index)
    const data = yield* encode(KnowledgeEntity, { ...entity, aliases, provenance })
    yield* tx.execute(`INSERT INTO efferent_knowledge.entities (${KEY},id,payload) VALUES ($1,$2,$3,$4,$5,$6::text::jsonb)
      ON CONFLICT (${KEY},id) DO UPDATE SET payload=EXCLUDED.payload`, [...params(domain, scope), entity.id, data])
    yield* tx.execute(`DELETE FROM efferent_knowledge.record_sources WHERE ${WHERE} AND kind='entity' AND record_id=$5`, [...params(domain, scope), entity.id])
    yield* recordSources(tx, scope, "entity", entity.id, provenance)
  })
  const insertAssertion = (tx: PostgresQueries, scope: KnowledgeScope, edge: KnowledgeAssertion) => Effect.gen(function* () {
    const data = yield* encode(KnowledgeAssertion, edge)
    const object = Match.valueTags(edge.object, { Entity: ({ entityId }) => entityId, Value: () => null })
    yield* tx.execute(`INSERT INTO efferent_knowledge.assertions (${KEY},id,subject,predicate,object_entity,valid_from,valid_to,known_from,known_to,payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::text::jsonb)`,
    [...params(domain, scope), edge.id, edge.subject, edge.predicate, object, nullable(edge.validFrom), nullable(edge.validTo), edge.knownFrom, nullable(edge.knownTo), data])
    yield* recordSources(tx, scope, "assertion", edge.id, edge.provenance)
  })
  const closeSource = (tx: PostgresQueries, scope: KnowledgeScope, sourceId: string, now: number) => Effect.gen(function* () {
    yield* tx.execute(`UPDATE efferent_knowledge.memories SET known_to=$6,payload=jsonb_set(payload,'{knownTo}',to_jsonb($6::bigint))
      WHERE ${WHERE} AND known_to IS NULL AND id IN (SELECT record_id FROM efferent_knowledge.record_sources WHERE ${WHERE} AND kind='memory' AND source_id=$5)`, [...params(domain, scope), sourceId, now])
    yield* tx.execute(`UPDATE efferent_knowledge.assertions SET known_to=$6,payload=jsonb_set(payload,'{knownTo}',to_jsonb($6::bigint))
      WHERE ${WHERE} AND known_to IS NULL AND id IN (SELECT record_id FROM efferent_knowledge.record_sources WHERE ${WHERE} AND kind='assertion' AND source_id=$5)`, [...params(domain, scope), sourceId, now])
    yield* tx.execute(`DELETE FROM efferent_knowledge.chunks WHERE ${WHERE} AND source_id=$5`, [...params(domain, scope), sourceId])
  })
  const retire = (tx: PostgresQueries, scope: KnowledgeScope, stage: KnowledgeStage, now: number) => Effect.gen(function* () {
    const memoryIds = yield* strings(stage.retireMemories)
    const edgeIds = yield* strings(stage.retireAssertions)
    yield* tx.execute(`UPDATE efferent_knowledge.memories SET known_to=$6,payload=jsonb_set(payload,'{knownTo}',to_jsonb($6::bigint)) WHERE ${WHERE} AND id IN (SELECT jsonb_array_elements_text($5::text::jsonb))`, [...params(domain, scope), memoryIds, now])
    yield* tx.execute(`UPDATE efferent_knowledge.assertions SET known_to=$6,payload=jsonb_set(payload,'{knownTo}',to_jsonb($6::bigint)) WHERE ${WHERE} AND id IN (SELECT jsonb_array_elements_text($5::text::jsonb))`, [...params(domain, scope), edgeIds, now])
  })
  const closeDependents = (tx: PostgresQueries, scope: KnowledgeScope, sourceId: string, retired: ReadonlyArray<string>, now: number) => Effect.gen(function* () {
    const ids = yield* strings(retired)
    yield* tx.execute(`WITH RECURSIVE closed(id) AS (
      SELECT record_id FROM efferent_knowledge.record_sources WHERE ${WHERE} AND kind='memory' AND source_id=$5
      UNION SELECT jsonb_array_elements_text($6::text::jsonb)
      UNION SELECT s.memory_id FROM efferent_knowledge.memory_supports s JOIN closed c ON s.support_id=c.id
        WHERE s.domain=$1 AND s.owner=$2 AND s.namespace=$3 AND s.collection=$4
    ) UPDATE efferent_knowledge.memories SET known_to=$7,payload=jsonb_set(payload,'{knownTo}',to_jsonb($7::bigint))
      WHERE ${WHERE} AND known_to IS NULL AND id IN (SELECT id FROM closed)`, [...params(domain, scope), sourceId, ids, now])
  })
  /** Source-level closure makes every output of a requeued source replaceable. */
  const rebuildSources = (tx: PostgresQueries, scope: KnowledgeScope, sourceId: string) => tx.rows(IdRow, `WITH RECURSIVE proofs AS (
    SELECT r.kind,r.record_id,r.source_id FROM efferent_knowledge.record_sources r
      WHERE r.domain=$1 AND r.owner=$2 AND r.namespace=$3 AND r.collection=$4 AND (
        (r.kind='memory' AND EXISTS (SELECT 1 FROM efferent_knowledge.memories m WHERE m.domain=$1 AND m.owner=$2 AND m.namespace=$3 AND m.collection=$4 AND m.id=r.record_id AND NOT m.invalidated))
        OR (r.kind='assertion' AND EXISTS (SELECT 1 FROM efferent_knowledge.assertions a WHERE a.domain=$1 AND a.owner=$2 AND a.namespace=$3 AND a.collection=$4 AND a.id=r.record_id AND NOT a.invalidated))
        OR (r.kind='entity' AND EXISTS (SELECT 1 FROM efferent_knowledge.entities e WHERE e.domain=$1 AND e.owner=$2 AND e.namespace=$3 AND e.collection=$4 AND e.id=r.record_id)))
    UNION SELECT i.kind,i.id,i.source_id FROM efferent_knowledge.identities i
      WHERE i.domain=$1 AND i.owner=$2 AND i.namespace=$3 AND i.collection=$4 AND (
        (i.kind='memory' AND EXISTS (SELECT 1 FROM efferent_knowledge.memories m WHERE m.domain=$1 AND m.owner=$2 AND m.namespace=$3 AND m.collection=$4 AND m.id=i.id AND NOT m.invalidated))
        OR (i.kind='assertion' AND EXISTS (SELECT 1 FROM efferent_knowledge.assertions a WHERE a.domain=$1 AND a.owner=$2 AND a.namespace=$3 AND a.collection=$4 AND a.id=i.id AND NOT a.invalidated))
        OR (i.kind='chunk' AND EXISTS (SELECT 1 FROM efferent_knowledge.chunks c WHERE c.domain=$1 AND c.owner=$2 AND c.namespace=$3 AND c.collection=$4 AND c.id=i.id)))
    UNION SELECT 'chunk',id,source_id FROM efferent_knowledge.chunks WHERE ${WHERE}
  ), links AS (
    SELECT p.source_id AS from_source,q.source_id AS to_source FROM proofs p JOIN proofs q ON p.kind=q.kind AND p.record_id=q.record_id
    UNION SELECT p.source_id,q.source_id FROM proofs p
      JOIN efferent_knowledge.memories m ON m.domain=$1 AND m.owner=$2 AND m.namespace=$3 AND m.collection=$4 AND NOT m.invalidated
        AND p.kind='entity' AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(m.payload->'entities') member WHERE member=p.record_id)
      JOIN proofs q ON q.kind='memory' AND q.record_id=m.id
    UNION SELECT p.source_id,q.source_id FROM proofs p
      JOIN efferent_knowledge.assertions a ON a.domain=$1 AND a.owner=$2 AND a.namespace=$3 AND a.collection=$4 AND NOT a.invalidated
        AND p.kind='entity' AND (a.subject=p.record_id OR a.object_entity=p.record_id)
      JOIN proofs q ON q.kind='assertion' AND q.record_id=a.id
    UNION SELECT p.source_id,q.source_id FROM proofs p
      JOIN efferent_knowledge.memory_supports s ON s.domain=$1 AND s.owner=$2 AND s.namespace=$3 AND s.collection=$4
        AND p.kind='memory' AND s.support_id=p.record_id
      JOIN proofs q ON q.kind='memory' AND q.record_id=s.memory_id
  ), affected(source_id) AS (
    SELECT $5::text UNION SELECT links.to_source FROM links JOIN affected ON links.from_source=affected.source_id
  ) SELECT source_id AS id FROM affected ORDER BY source_id`, [...params(domain, scope), sourceId])
  const traverse = (query: KnowledgeTraversal): Effect.Effect<KnowledgeSubgraph, KnowledgeError> => db.transaction((tx) => Effect.gen(function* () {
    yield* lockScope(tx, query.scope)
    const seeds = [...new Set(query.seeds)].slice(0, query.limit)
    const visit = (frontier: ReadonlyArray<string>, seen: ReadonlyArray<string>, edges: ReadonlyArray<KnowledgeAssertion>, depth: number, truncated: boolean): Effect.Effect<{ readonly ids: ReadonlyArray<string>; readonly edges: ReadonlyArray<KnowledgeAssertion>; readonly truncated: boolean }, KnowledgeError> => Effect.gen(function* () {
      if (depth === 0 || frontier.length === 0) return { ids: seen, edges, truncated }
      const frontierJson = yield* strings(frontier)
      const edgeJson = yield* strings(edges.map((edge) => edge.id))
      const available = Math.max(0, query.limit - edges.length)
      const found = yield* payloads(tx, KnowledgeAssertion, `SELECT payload FROM efferent_knowledge.assertions WHERE ${WHERE} AND NOT invalidated
        AND known_from <= $5 AND (known_to IS NULL OR $5 < known_to)
        AND (valid_from IS NULL OR valid_from <= $6) AND (valid_to IS NULL OR $6 < valid_to)
        AND (subject IN (SELECT jsonb_array_elements_text($7::text::jsonb)) OR object_entity IN (SELECT jsonb_array_elements_text($7::text::jsonb)))
        AND id NOT IN (SELECT jsonb_array_elements_text($8::text::jsonb)) ORDER BY id LIMIT $9`,
      [...params(domain, query.scope), query.perspective.knownAt, query.perspective.validAt, frontierJson, edgeJson, available + 1])
      const selected = found.slice(0, available)
      const discovered = [...new Set(selected.flatMap((edge) => Match.valueTags(edge.object, { Entity: ({ entityId }) => [edge.subject, entityId], Value: () => [edge.subject] })))].filter((id) => !seen.includes(id))
      const kept = discovered.slice(0, Math.max(0, query.limit - seen.length))
      return yield* visit(kept, [...seen, ...kept], [...edges, ...selected], depth - 1, truncated || found.length > available || discovered.length > kept.length)
    })
    const result = yield* visit(seeds, seeds, [], Math.min(query.depth, 3), query.seeds.length > seeds.length)
    const ids = yield* strings(result.ids)
    const entities = yield* payloads(tx, KnowledgeEntity, `SELECT payload FROM efferent_knowledge.entities WHERE ${WHERE} AND id IN (SELECT jsonb_array_elements_text($5::text::jsonb)) ORDER BY id`, [...params(domain, query.scope), ids])
    const kept = entities.map((entity) => entity.id)
    const assertions = result.edges.filter((edge) => kept.includes(edge.subject) && Match.valueTags(edge.object, { Entity: ({ entityId }) => kept.includes(entityId), Value: () => true }))
    return { entities, assertions, truncated: result.truncated || assertions.length !== result.edges.length }
  }))

  return {
    enqueue: Effect.fn("knowledge_store.enqueue")(function* (input) {
      return yield* db.transaction((tx) => Effect.gen(function* () {
        yield* lockScope(tx, input.source.scope)
        const current = yield* head(tx, input.source.scope, input.source.ref.id)
        if (Option.isSome(current) && current.value.tombstone_at !== null) return yield* invalid("Tombstoned", "the source has been forgotten")
        const reused = yield* status(tx, input.source.scope, input.jobId)
        if (Option.isSome(reused) && (reused.value.source.id !== input.source.ref.id || reused.value.source.revision !== input.source.ref.revision || reused.value.engine !== input.engine)) return yield* invalid("Conflict", "the job identity already belongs to another source or engine")
        const data = yield* encode(KnowledgeSource, input.source)
        const oldSources = yield* tx.rows(CountRow, `SELECT count(*)::float8 AS count FROM efferent_knowledge.sources WHERE ${WHERE} AND source_id=$5 AND revision=$6 AND payload <> $7::text::jsonb`, [...params(domain, input.source.scope), input.source.ref.id, input.source.ref.revision, data])
        if ((oldSources[0]?.count ?? 0) > 0) return yield* invalid("Conflict", "the source revision already contains different evidence")
        const replay = yield* payloads(tx, KnowledgeJob, `SELECT payload FROM efferent_knowledge.jobs WHERE ${WHERE} AND source_id=$5 AND source_revision=$6 AND engine=$7`, [...params(domain, input.source.scope), input.source.ref.id, input.source.ref.revision, input.engine])
        if (replay[0]) return replay[0]
        const revision = Option.match(current, { onNone: () => 0, onSome: (value) => value.accepted_revision })
        const matches = Option.match(input.expectedRevision, { onNone: () => revision === 0, onSome: (expected) => revision === expected })
        if (!matches || input.source.ref.revision <= revision) return yield* invalid("Conflict", "the source revision changed or did not advance")
        yield* tx.execute(`INSERT INTO efferent_knowledge.heads (${KEY},source_id,accepted_revision) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (${KEY},source_id) DO UPDATE SET accepted_revision=EXCLUDED.accepted_revision`, [...params(domain, input.source.scope), input.source.ref.id, input.source.ref.revision])
        yield* tx.execute(`INSERT INTO efferent_knowledge.sources (${KEY},source_id,revision,payload) VALUES ($1,$2,$3,$4,$5,$6,$7::text::jsonb) ON CONFLICT DO NOTHING`, [...params(domain, input.source.scope), input.source.ref.id, input.source.ref.revision, data])
        yield* tx.execute(`UPDATE efferent_knowledge.jobs SET phase='Cancelled',lease_token=NULL,lease_until=NULL,
          payload=jsonb_set(jsonb_set(payload,'{phase}',jsonb_build_object('_tag','Cancelled','cancelledAt',$7::bigint)),'{stage}','null'::jsonb)
          WHERE ${WHERE} AND source_id=$5 AND source_revision < $6 AND phase IN ('Queued','Processing','Failed')`, [...params(domain, input.source.scope), input.source.ref.id, input.source.ref.revision, input.source.recordedAt])
        const job: KnowledgeJob = { id: input.jobId, scope: input.source.scope, source: input.source.ref, engine: input.engine, attempt: 0, phase: { _tag: "Queued" }, stage: Option.none() }
        yield* saveJob(tx, job)
        return job
      }))
    }),
    pending: Effect.fn("knowledge_store.pending")(function* (input) {
      return yield* payloads(db, KnowledgeJob, `SELECT j.payload FROM efferent_knowledge.jobs j JOIN efferent_knowledge.heads h USING (${KEY}, source_id)
        WHERE j.domain=$1 AND j.namespace=$2 AND j.engine=$3 AND h.tombstone_at IS NULL AND j.source_revision=h.accepted_revision
        AND (j.phase='Queued' OR (j.phase='Processing' AND j.lease_until <= $4))
        AND ($6::text IS NULL OR j.collection=$6) ORDER BY j.ordinal LIMIT $5`, [domain, input.namespace, input.engine, input.now, input.limit, input.collection ?? null])
    }),
    claim: Effect.fn("knowledge_store.claim")(function* (input) {
      return yield* db.transaction((tx) => Effect.gen(function* () {
        const rows = yield* payloads(tx, KnowledgeJob, `SELECT j.payload FROM efferent_knowledge.jobs j JOIN efferent_knowledge.heads h USING (${KEY},source_id)
          WHERE j.domain=$1 AND j.owner=$2 AND j.namespace=$3 AND j.collection=$4 AND h.tombstone_at IS NULL AND j.source_revision=h.accepted_revision
          AND (j.phase='Queued' OR (j.phase='Processing' AND j.lease_until <= $5)) AND ($6::text IS NULL OR j.id=$6) AND j.engine=$7
          ORDER BY j.ordinal LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, [...params(domain, input.scope), input.now, input.jobId ?? null, input.engine])
        const prior = rows[0]
        if (!prior) return Option.none()
        const job: KnowledgeJob = { ...prior, attempt: prior.attempt + 1, phase: { _tag: "Processing", token: input.token, worker: input.worker, leaseUntil: input.now + input.leaseMs } }
        yield* saveJob(tx, job)
        return Option.some(job)
      }))
    }),
    renew: Effect.fn("knowledge_store.renew")(function* (lease, leaseMs) {
      if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) return yield* invalid("Invalid", "lease duration must be a positive integer")
      return yield* db.transaction((tx) => Effect.gen(function* () {
        const job = yield* leased(tx, lease)
        const phase = Match.valueTags(job.phase, { Processing: (value) => ({ ...value, leaseUntil: lease.now + leaseMs }), Queued: (value) => value, Failed: (value) => value, Complete: (value) => value, Cancelled: (value) => value })
        const renewed = { ...job, phase }
        yield* saveJob(tx, renewed)
        return renewed
      }))
    }),
    stage: Effect.fn("knowledge_store.stage")(function* (lease, stage) {
      yield* db.transaction((tx) => Effect.gen(function* () {
        yield* lockScope(tx, lease.scope)
        const job = yield* leased(tx, lease)
        yield* validateStage(tx, lease, stage)
        yield* saveJob(tx, { ...job, stage: Option.some(stage) })
      }))
    }),
    publish: Effect.fn("knowledge_store.publish")(function* (lease) {
      yield* db.transaction((tx) => Effect.gen(function* () {
        yield* lockScope(tx, lease.scope)
        const previous = yield* status(tx, lease.scope, lease.jobId)
        if (Option.isSome(previous) && previous.value.phase._tag === "Complete") return
        const job = yield* leased(tx, lease)
        if (Option.isNone(job.stage)) return yield* invalid("Conflict", "the knowledge job has no current staged extraction")
        const stage = job.stage.value
        const profile = yield* validateStage(tx, lease, stage)
        const referenced = [...stage.memories.flatMap((memory) => memory.provenance), ...stage.chunks.map((chunk) => chunk.provenance), ...stage.assertions.flatMap((edge) => edge.provenance), ...stage.entities.flatMap((entity) => entity.provenance)]
        if (referenced.some((span) => span.source.id === job.source.id && span.source.revision !== job.source.revision)) return yield* invalid("Invalid", "the staged extraction cites an earlier revision of its own source")
        const identities: ReadonlyArray<{ readonly kind: "memory" | "chunk" | "assertion"; readonly id: string }> = [
          ...stage.memories.map((memory) => ({ kind: "memory" as const, id: memory.id })),
          ...stage.chunks.map((chunk) => ({ kind: "chunk" as const, id: chunk.id })),
          ...stage.assertions.map((edge) => ({ kind: "assertion" as const, id: edge.id })),
        ]
        yield* Effect.forEach(identities, (item) => Effect.gen(function* () {
          const prior = yield* tx.rows(IdentityRow, `SELECT source_id,source_revision::float8 AS source_revision FROM efferent_knowledge.identities WHERE ${WHERE} AND kind=$5 AND id=$6`, [...params(domain, lease.scope), item.kind, item.id])
          const identity = prior[0]
          if (identity && (identity.source_id !== job.source.id || identity.source_revision !== job.source.revision)) return yield* invalid("Conflict", "a record identity belongs to another source revision")
          const table = { memory: "memories", chunk: "chunks", assertion: "assertions" }[item.kind]
          const live = item.kind === "chunk" ? "" : " AND NOT invalidated"
          const present = yield* tx.rows(CountRow, `SELECT count(*)::float8 AS count FROM efferent_knowledge.${table} WHERE ${WHERE} AND id=$5${live}`, [...params(domain, lease.scope), item.id])
          if ((present[0]?.count ?? 0) > 0) return yield* invalid("Conflict", "a published record identity is immutable")
          if (item.kind !== "chunk") yield* tx.execute(`DELETE FROM efferent_knowledge.${table} WHERE ${WHERE} AND id=$5 AND invalidated`, [...params(domain, lease.scope), item.id])
          yield* tx.execute(`DELETE FROM efferent_knowledge.record_sources WHERE ${WHERE} AND kind=$5 AND record_id=$6`, [...params(domain, lease.scope), item.kind, item.id])
          if (item.kind === "memory") yield* tx.execute(`DELETE FROM efferent_knowledge.memory_supports WHERE ${WHERE} AND memory_id=$5`, [...params(domain, lease.scope), item.id])
          yield* tx.execute(`INSERT INTO efferent_knowledge.identities (${KEY},kind,id,source_id,source_revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [...params(domain, lease.scope), item.kind, item.id, job.source.id, job.source.revision])
        }), { concurrency: 1 })
        yield* closeSource(tx, lease.scope, job.source.id, lease.now)
        yield* retire(tx, lease.scope, stage, lease.now)
        yield* closeDependents(tx, lease.scope, job.source.id, stage.retireMemories, lease.now)
        yield* Effect.forEach(stage.entities, (entity) => insertEntity(tx, lease.scope, entity), { concurrency: 1 })
        yield* Effect.forEach(stage.memories, (memory) => insertMemory(tx, lease.scope, { ...memory, knownFrom: lease.now, knownTo: Option.none() }), { concurrency: 1 })
        yield* Effect.forEach(stage.chunks, (chunk) => insertChunk(tx, lease.scope, chunk), { concurrency: 1 })
        yield* Effect.forEach(stage.assertions, (edge) => insertAssertion(tx, lease.scope, { ...edge, knownFrom: lease.now, knownTo: Option.none() }), { concurrency: 1 })
        const encodedProfile = profile ? yield* encode(KnowledgeEmbeddingSpace, profile) : null
        yield* tx.execute(`UPDATE efferent_knowledge.scopes SET version=version+1, embedding_profile=coalesce(embedding_profile,$5::text::jsonb) WHERE ${WHERE}`, [...params(domain, lease.scope), encodedProfile])
        yield* tx.execute(`UPDATE efferent_knowledge.heads SET published_revision=$6 WHERE ${WHERE} AND source_id=$5`, [...params(domain, lease.scope), job.source.id, job.source.revision])
        yield* saveJob(tx, { ...job, phase: { _tag: "Complete", publishedAt: lease.now } })
      }))
    }),
    fail: Effect.fn("knowledge_store.fail")(function* (lease, message) {
      yield* db.transaction((tx) => Effect.gen(function* () {
        const job = yield* leased(tx, lease)
        yield* saveJob(tx, { ...job, phase: { _tag: "Failed", message } })
      }))
    }),
    retry: Effect.fn("knowledge_store.retry")(function* (scope, id) {
      return yield* db.transaction((tx) => Effect.gen(function* () {
        const found = yield* status(tx, scope, id, true)
        if (Option.isNone(found)) return yield* invalid("Invalid", "the knowledge job does not exist")
        const current = yield* head(tx, scope, found.value.source.id)
        if (Option.isNone(current) || current.value.tombstone_at !== null) return yield* invalid("Tombstoned", "the source has been forgotten")
        if (current.value.accepted_revision !== found.value.source.revision) return yield* invalid("Conflict", "a newer source revision superseded this job")
        if (found.value.phase._tag !== "Failed") return yield* invalid("Conflict", "only failed jobs can be retried")
        const job: KnowledgeJob = { ...found.value, phase: { _tag: "Queued" } }
        yield* saveJob(tx, job)
        return job
      }))
    }),
    status: Effect.fn("knowledge_store.status")((scope, id) => status(db, scope, id)),
    snapshot: Effect.fn("knowledge_store.snapshot")((scope) => db.transaction((tx) => lockScope(tx, scope).pipe(Effect.andThen(snapshot(tx, scope))))),
    search: Effect.fn("knowledge_store.search")(function* (query) {
      return yield* db.transaction((tx) => Effect.gen(function* () {
        const scope = yield* lockScope(tx, query.scope)
        const vector = nullable(query.vector)
        if (vector && (vector.values.length !== vector.space.dimensions || vector.space.dimensions > 16_000 || !vector.values.every(Number.isFinite))) return yield* invalid("EmbeddingMismatch", "the query embedding has invalid dimensions or values")
        if (vector && scope.embedding_profile && !sameEmbeddingSpace(scope.embedding_profile, vector.space)) return yield* invalid("EmbeddingMismatch", "the query embedding differs from the stored index")
        const when = nullable(query.knownAt)
        const base = params(domain, query.scope)
        const memoryTime = "(($5::float8 IS NULL AND known_to IS NULL) OR ($5::float8 IS NOT NULL AND known_from <= $5 AND (known_to IS NULL OR $5 < known_to)))"
        const lexicalMemories = yield* tx.rows(memoryScore, `SELECT payload,ts_rank_cd(lexical,${lexicalQuery(6)})::float8 AS score FROM efferent_knowledge.memories WHERE ${WHERE} AND NOT invalidated AND ${memoryTime} AND lexical @@ ${lexicalQuery(6)} ORDER BY score DESC,id LIMIT $7`, [...base, when, query.query, query.limit])
        const lexicalChunks = yield* tx.rows(chunkScore, `SELECT payload,ts_rank_cd(lexical,${lexicalQuery(5)})::float8 AS score FROM efferent_knowledge.chunks WHERE ${WHERE} AND lexical @@ ${lexicalQuery(5)} ORDER BY score DESC,id LIMIT $6`, [...base, query.query, query.limit])
        const semanticMemories = vector ? yield* tx.rows(memoryScore, `SELECT payload,CASE WHEN vector_norm(embedding)=0 OR vector_norm($6::vector)=0 THEN 0 ELSE 1-(embedding <=> $6::vector) END::float8 AS score FROM efferent_knowledge.memories WHERE ${WHERE} AND NOT invalidated AND ${memoryTime} AND embedding IS NOT NULL ORDER BY score DESC,id LIMIT $7`, [...base, when, vectorText(vector), query.limit]) : []
        const semanticChunks = vector ? yield* tx.rows(chunkScore, `SELECT payload,CASE WHEN vector_norm(embedding)=0 OR vector_norm($5::vector)=0 THEN 0 ELSE 1-(embedding <=> $5::vector) END::float8 AS score FROM efferent_knowledge.chunks WHERE ${WHERE} AND embedding IS NOT NULL ORDER BY score DESC,id LIMIT $6`, [...base, vectorText(vector), query.limit]) : []
        const combine = (memories: ReadonlyArray<{ readonly payload: KnowledgeMemory; readonly score: number }>, chunks: ReadonlyArray<{ readonly payload: KnowledgeChunk; readonly score: number }>): ReadonlyArray<KnowledgeCandidate> => [
          ...memories.map(({ payload, score }): KnowledgeCandidate => ({ _tag: "Memory", memory: payload, score })),
          ...chunks.map(({ payload, score }): KnowledgeCandidate => ({ _tag: "Chunk", chunk: payload, score })),
        ].toSorted((a, b) => b.score - a.score || Order.String(a._tag === "Memory" ? a.memory.id : a.chunk.id, b._tag === "Memory" ? b.memory.id : b.chunk.id)).slice(0, query.limit)
        return { lexical: combine(lexicalMemories, lexicalChunks), semantic: combine(semanticMemories, semanticChunks) } satisfies KnowledgeCandidates
      }))
    }),
    source: Effect.fn("knowledge_store.source")(function* (scope, ref) {
      const rows = yield* payloads(db, KnowledgeSource, `SELECT s.payload FROM efferent_knowledge.sources s JOIN efferent_knowledge.heads h USING (${KEY},source_id)
        WHERE s.domain=$1 AND s.owner=$2 AND s.namespace=$3 AND s.collection=$4 AND s.source_id=$5 AND s.revision=$6 AND h.tombstone_at IS NULL`, [...params(domain, scope), ref.id, ref.revision])
      return Option.fromNullishOr(rows[0])
    }),
    memory: Effect.fn("knowledge_store.memory")(function* (scope, id) {
      const rows = yield* payloads(db, KnowledgeMemory, `SELECT payload FROM efferent_knowledge.memories WHERE ${WHERE} AND id=$5 AND NOT invalidated`, [...params(domain, scope), id])
      return Option.fromNullishOr(rows[0])
    }),
    chunk: Effect.fn("knowledge_store.chunk")(function* (scope, id) {
      const rows = yield* payloads(db, KnowledgeChunk, `SELECT payload FROM efferent_knowledge.chunks WHERE ${WHERE} AND id=$5`, [...params(domain, scope), id])
      return Option.fromNullishOr(rows[0])
    }),
    forget: Effect.fn("knowledge_store.forget")(function* (scope, id, now) {
      yield* db.transaction((tx) => Effect.gen(function* () {
        yield* lockScope(tx, scope)
        const current = yield* head(tx, scope, id)
        if (Option.isSome(current) && current.value.tombstone_at !== null) return
        yield* tx.execute(`INSERT INTO efferent_knowledge.heads (${KEY},source_id,tombstone_at) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (${KEY},source_id) DO UPDATE SET tombstone_at=coalesce(efferent_knowledge.heads.tombstone_at,EXCLUDED.tombstone_at)`, [...params(domain, scope), id, now])
        yield* tx.execute(`UPDATE efferent_knowledge.jobs SET phase='Cancelled',lease_token=NULL,lease_until=NULL,
          payload=jsonb_set(jsonb_set(payload,'{phase}',jsonb_build_object('_tag','Cancelled','cancelledAt',$6::bigint)),'{stage}','null'::jsonb)
          WHERE ${WHERE} AND source_id=$5 AND phase <> 'Cancelled'`, [...params(domain, scope), id, now])
        const affected = yield* rebuildSources(tx, scope, id)
        const affectedIds = yield* strings(affected.map((row) => row.id))
        const entityRows = yield* tx.rows(IdRow, `SELECT record_id AS id FROM efferent_knowledge.record_sources WHERE ${WHERE} AND kind='entity' AND source_id IN (SELECT jsonb_array_elements_text($5::text::jsonb))`, [...params(domain, scope), affectedIds])
        const entities = yield* strings(entityRows.map((row) => row.id))
        const purgedMemories = yield* tx.rows(IdRow, `DELETE FROM efferent_knowledge.memories WHERE ${WHERE}
          AND (id IN (SELECT record_id FROM efferent_knowledge.record_sources WHERE ${WHERE} AND kind='memory' AND source_id IN (SELECT jsonb_array_elements_text($5::text::jsonb)))
            OR id IN (SELECT id FROM efferent_knowledge.identities WHERE ${WHERE} AND kind='memory' AND source_id IN (SELECT jsonb_array_elements_text($5::text::jsonb)))) RETURNING id`, [...params(domain, scope), affectedIds])
        const purgedAssertions = yield* tx.rows(IdRow, `DELETE FROM efferent_knowledge.assertions WHERE ${WHERE}
          AND (id IN (SELECT record_id FROM efferent_knowledge.record_sources WHERE ${WHERE} AND kind='assertion' AND source_id IN (SELECT jsonb_array_elements_text($5::text::jsonb)))
            OR id IN (SELECT id FROM efferent_knowledge.identities WHERE ${WHERE} AND kind='assertion' AND source_id IN (SELECT jsonb_array_elements_text($5::text::jsonb)))) RETURNING id`, [...params(domain, scope), affectedIds])
        const memoryIds = yield* strings(purgedMemories.map((row) => row.id))
        const assertionIds = yield* strings(purgedAssertions.map((row) => row.id))
        yield* tx.execute(`DELETE FROM efferent_knowledge.memory_supports WHERE ${WHERE}
          AND (memory_id IN (SELECT jsonb_array_elements_text($5::text::jsonb)) OR support_id IN (SELECT jsonb_array_elements_text($5::text::jsonb)))`, [...params(domain, scope), memoryIds])
        yield* tx.execute(`DELETE FROM efferent_knowledge.record_sources WHERE ${WHERE}
          AND ((kind='memory' AND record_id IN (SELECT jsonb_array_elements_text($5::text::jsonb)))
            OR (kind='assertion' AND record_id IN (SELECT jsonb_array_elements_text($6::text::jsonb))))`, [...params(domain, scope), memoryIds, assertionIds])
        yield* tx.execute(`UPDATE efferent_knowledge.jobs SET payload=jsonb_set(payload,'{stage}','null'::jsonb)
          WHERE ${WHERE}`, params(domain, scope))
        yield* tx.execute(`UPDATE efferent_knowledge.jobs j SET phase='Queued',lease_token=NULL,lease_until=NULL,
          payload=jsonb_set(jsonb_set(j.payload,'{phase}','{"_tag":"Queued"}'::jsonb),'{stage}','null'::jsonb)
          WHERE j.domain=$1 AND j.owner=$2 AND j.namespace=$3 AND j.collection=$4 AND j.source_id <> $5
          AND EXISTS (SELECT 1 FROM efferent_knowledge.heads h WHERE h.domain=$1 AND h.owner=$2 AND h.namespace=$3 AND h.collection=$4 AND h.source_id=j.source_id AND h.accepted_revision=j.source_revision AND h.tombstone_at IS NULL)
          AND j.source_id IN (SELECT jsonb_array_elements_text($6::text::jsonb))`, [...params(domain, scope), id, affectedIds])
        yield* tx.execute(`DELETE FROM efferent_knowledge.entities WHERE ${WHERE} AND id IN (SELECT jsonb_array_elements_text($5::text::jsonb))`, [...params(domain, scope), entities])
        yield* tx.execute(`DELETE FROM efferent_knowledge.record_sources WHERE ${WHERE} AND kind='entity' AND record_id IN (SELECT jsonb_array_elements_text($5::text::jsonb))`, [...params(domain, scope), entities])
        yield* tx.execute(`DELETE FROM efferent_knowledge.chunks WHERE ${WHERE}
          AND (source_id IN (SELECT jsonb_array_elements_text($5::text::jsonb))
            OR id IN (SELECT id FROM efferent_knowledge.identities WHERE ${WHERE} AND kind='chunk' AND source_id IN (SELECT jsonb_array_elements_text($5::text::jsonb))))`, [...params(domain, scope), affectedIds])
        yield* tx.execute(`DELETE FROM efferent_knowledge.sources WHERE ${WHERE} AND source_id=$5`, [...params(domain, scope), id])
        yield* tx.execute(`UPDATE efferent_knowledge.scopes SET version=version+1 WHERE ${WHERE}`, params(domain, scope))
      }))
    }),
    traverse: Effect.fn("knowledge_store.traverse")(traverse),
  }
}
