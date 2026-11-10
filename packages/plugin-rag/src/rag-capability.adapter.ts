import { Effect, Option, Schema } from "effect"
import { Tool } from "effect/ai"
import {
  admitsKnowledgeSource, defineCapability, definePromptSection, defineSkill, defineTool, Failure, Knowledge, KnowledgeNarrowing, KnowledgeRecallResult,
  KnowledgeSourceId, RunContext, userMessageText,
} from "@xandreed/core"
import type { KnowledgeReach, KnowledgeScope } from "@xandreed/core"
import type { RagConfig } from "./rag.entity.js"
import { knowledgeEvidenceText, knowledgeSourcePage } from "./rag.entity.functions.js"

/** Exact text contracts shared by declarations, views and tests. */
export const ragText = (config: RagConfig) => ({
  search: `Search the documents in your current collection. Returns up to ${config.searchLimit} excerpts with source ids, revisions, and exact character ranges, within ${config.evidenceChars} evidence characters. Read a cited source with read_knowledge.`,
  read: `Read a cited source revision from your current collection. Returns up to ${config.readChars} characters from offset, with the next offset when more remains. Find source ids and revisions with search_knowledge.`,
  query: "The question, exact identifier, or terms to find in the documents.",
  graph: "Expand matching evidence through document relationships when available.",
  validAt: "World time in epoch milliseconds for relationship filtering; defaults to the current time.",
  knownAt: "Recorded knowledge time in epoch milliseconds for relationship filtering; defaults to the current time.",
  sourceId: "The source id returned by search_knowledge, exactly as written.",
  revision: "The source revision returned by search_knowledge.",
  offset: "The first UTF-16 character to read; zero by default.",
  skill: "Find documents and read their cited evidence.",
  unavailable: { error: "KnowledgeUnavailable", message: "The knowledge collection could not be read. Retry search_knowledge." },
  missing: { error: "NotFound", message: "No source revision is available in this collection. Use a source id and revision from search_knowledge." },
  offsetError: { error: "OffsetOutOfRange", message: "The offset is past the end of this source. Use a smaller offset." },
})

/** Runtime capability; each operation reads the run's reach (`KnowledgeNarrowing`): by default, the caller's authenticated owner. */
export const ragCapability = (config: RagConfig) => {
  const text = ragText(config)
  const scopeOf = (owner: string): KnowledgeScope => ({ owner, namespace: config.namespace, collection: config.collection })
  const reachOf = Effect.fnUntraced(function* () {
    const run = yield* RunContext
    return yield* (yield* KnowledgeNarrowing).reach(run)
  })
  const narrowingOf = (reach: KnowledgeReach) => ({
    ...(reach.sources === undefined ? {} : { sources: reach.sources }), ...(reach.metadata === undefined ? {} : { metadata: reach.metadata }),
  })
  const Search = Tool.make("search_knowledge", {
    description: text.search,
    parameters: Schema.Struct({
      query: Schema.String.annotate({ description: text.query }),
      graph: Schema.optionalKey(Schema.Boolean.annotate({ description: text.graph })),
      validAt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: text.validAt })),
      knownAt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: text.knownAt })),
    }), success: KnowledgeRecallResult, failure: Failure, failureMode: "return",
  })
  const Read = Tool.make("read_knowledge", {
    description: text.read,
    parameters: Schema.Struct({
      sourceId: KnowledgeSourceId.annotate({ description: text.sourceId }),
      revision: Schema.Int.check(Schema.isGreaterThan(0)).annotate({ description: text.revision }),
      offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({ description: text.offset })),
    }), success: Schema.String, failure: Failure, failureMode: "return",
  })
  return defineCapability({
    id: "@xandreed/plugin-rag/documents", version: "1",
    tools: config.tools ? [
      defineTool({ tool: Search, requires: [Knowledge, RunContext], annotations: { readOnly: true },
        handler: (params) => Effect.gen(function* () {
          const reach = yield* reachOf().pipe(Effect.mapError(() => text.unavailable))
          const knowledge = yield* Knowledge
          const graph = params.graph === false ? false : (params.graph === true || config.graph || params.validAt !== undefined || params.knownAt !== undefined)
            ? { perspective: { ...(params.validAt === undefined ? {} : { validAt: params.validAt }), ...(params.knownAt === undefined ? {} : { knownAt: params.knownAt }) }, depth: config.graphDepth }
            : undefined
          return yield* knowledge.retrieve({ scope: scopeOf(reach.owner), query: params.query, limit: config.searchLimit, maxChars: config.evidenceChars,
            ...(graph === undefined ? {} : { graph }), ...narrowingOf(reach),
          }).pipe(Effect.mapError(() => text.unavailable))
        }),
        view: { version: "1", render: (result) => knowledgeEvidenceText(result, config.evidenceChars) },
      }),
      // A page ends with the offset to continue at, which a memory strategy's cut would hide: read_knowledge pages itself (boundOnWriteChars: 0).
      defineTool({ tool: Read, requires: [Knowledge, RunContext], annotations: { readOnly: true, boundOnWriteChars: 0 },
        handler: (params) => Effect.gen(function* () {
          const reach = yield* reachOf().pipe(Effect.mapError(() => text.unavailable))
          const source = reach.sources === undefined || reach.sources.includes(params.sourceId)
            ? yield* (yield* Knowledge).source(scopeOf(reach.owner), { id: params.sourceId, revision: params.revision }).pipe(Effect.mapError(() => text.unavailable))
            : Option.none()
          // A revision outside the reach's metadata filter is not found, as one outside its source list is.
          return yield* Option.match(Option.filter(source, (found) => admitsKnowledgeSource(reach, found)), {
            onNone: () => Effect.fail(text.missing),
            onSome: (found) => (params.offset ?? 0) > found.text.length ? Effect.fail(text.offsetError) : Effect.succeed(knowledgeSourcePage(found, params.offset ?? 0, config.readChars)),
          })
        }),
      }),
    ] : [],
    skills: config.tools ? [defineSkill({ id: "knowledge.documents", summary: text.skill, tools: ["search_knowledge", "read_knowledge"], always: true })] : [],
    promptSections: config.recall ? [definePromptSection({
      id: "knowledge.evidence", version: "1", tier: "turn", order: config.sectionOrder, requires: [Knowledge, RunContext],
      render: () => Effect.gen(function* () {
        const run = yield* RunContext
        const knowledge = yield* Knowledge
        const evidence = yield* reachOf().pipe(Effect.flatMap((reach) => knowledge.retrieve({ scope: scopeOf(reach.owner), query: userMessageText(run.userMessage), limit: config.searchLimit, maxChars: config.evidenceChars,
          ...(config.graph ? { graph: { perspective: {}, depth: config.graphDepth } } : {}), ...narrowingOf(reach),
        })), Effect.tapError((cause) => Effect.logWarning("Document evidence was unavailable for this turn", cause)), Effect.option)
        return Option.flatMap(evidence, (result) => result.candidates.length === 0 && result.graph.assertions.length === 0 ? Option.none() : Option.some(knowledgeEvidenceText(result, config.evidenceChars)))
      }),
    })] : [],
  })
}
