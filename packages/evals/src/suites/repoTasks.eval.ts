import { execFileSync } from "node:child_process"
import { Effect } from "effect"
import { defineEval } from "../framework/Eval.js"
import { fromEffect, predicate } from "../framework/scorers.js"
import { type RepoRun, runRepoTask } from "../support/repoTask.js"
import type { EvalEnv } from "../env.js"

/**
 * **Real-commit tasks.** Instead of synthetic toys, each case is a real feature
 * from this repo's history: the agent gets the codebase *before* the commit and
 * must implement what the commit did; the verdict is the **test that shipped
 * with that commit** (the ground-truth oracle), run in a per-case Docker sandbox
 * so the agent's bash + the verify are isolated and cases parallelise safely.
 *
 * The shipped test fully specifies the API + behavior — the agent reads it and
 * implements the module from scratch. We restore the canonical test before
 * grading so a model can't "pass" by weakening the test.
 */

const REPO_ROOT = ((): string => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
  } catch {
    return process.cwd()
  }
})()

// Fail-soft: these refs are old commits that may not exist after history
// rewrites / the monorepo rename. A missing ref must NOT crash module load —
// `run.ts` imports every suite, so a throw here took down the ENTIRE `bun run
// eval` (even `eval quality`). Return "" instead; the case then has an empty
// oracle and scores poorly (visible), rather than killing the whole CLI.
const gitShow = (ref: string, path: string): string => {
  try {
    return execFileSync("git", ["show", `${ref}:${path}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch {
    console.warn(`repo-tasks: could not load ${ref}:${path} (skipping its oracle)`)
    return ""
  }
}

interface RepoInput {
  readonly files: Record<string, string>
  readonly prompt: string
  readonly testPaths: ReadonlyArray<string>
  readonly canonicalTests: Record<string, string>
}

// — Case 1: structure-aware compression (new pure module, commit 773da5268b0) —
const compactionTest = gitShow(
  "773da5268b0",
  "packages/core/src/usecases/compactionContent.test.ts",
)

// — Case 2: shared sub-agent token budget (new module, commit d6d5d7f7d4e) —
const tokenBudgetTest = gitShow(
  "d6d5d7f7d4e",
  "packages/core/src/usecases/tokenBudget.test.ts",
)

// — Case 3 (HARD): the Prompt↔Response mapping bridge (commit 7e9987a3c2e) —
// 11 exported functions, a property-based oracle (FastCheck over the AgentMessage
// Schema), and provider-specific token-usage folding (Anthropic cache read+write
// fold-back, Gemini usageMetadata fallback, OpenCode double-finish, precedence).
// Multi-file: the test imports the AgentMessage Schema + TokenUsage type, so we
// materialise those two type files (both `effect`-only) as fixed context and the
// agent implements `usecases/promptMapping.ts` against them. All four pinned to
// the same commit so the snapshot is self-consistent.
const PM_REF = "7e9987a3c2e"
const promptMappingTest = gitShow(PM_REF, "packages/core/src/usecases/promptMapping.test.ts")
const conversationEntity = gitShow(PM_REF, "packages/core/src/entities/Conversation.ts")
const llmInfoPort = gitShow(PM_REF, "packages/core/src/ports/LlmInfo.ts")

// — Case 4 (HIDDEN-ORACLE bug-fix, SWE-bench-style): bound the SCOPE.md walk —
// Real fix commit 922f69bf8dc. The agent gets the repo BEFORE the fix (the
// unbounded recursive-list version of `discoverScopeTree.ts`) + an issue-style
// description, and must localise + fix the defect. The grading test is the
// regression test that shipped WITH the fix — and it is **never placed in the
// agent's workspace**: it's restored only at grade time (`canonicalTests`),
// exactly like SWE-bench's hidden FAIL_TO_PASS. So the model can't read the
// assertions and implement to them — it has to get the bounded-BFS behaviour
// right blind. Verified FAIL_TO_PASS: buggy source → 6 pass / 7 fail; the fix →
// 13 / 0. `testRatio` gives partial credit; `allPass` needs the whole fix.
const SCOPE_FIX = "922f69bf8dc"
const scopeBuggy = gitShow(`${SCOPE_FIX}^`, "packages/core/src/usecases/discoverScopeTree.ts")
const scopeHiddenTest = gitShow(SCOPE_FIX, "packages/core/src/usecases/discoverScopeTree.test.ts")
// Fixed-context deps (unchanged by the fix; the agent must not edit them):
const scopeDeps = {
  "usecases/discoverInstructionFiles.ts": gitShow(
    SCOPE_FIX,
    "packages/core/src/usecases/discoverInstructionFiles.ts",
  ),
  "prompts/coder.ts": gitShow(SCOPE_FIX, "packages/core/src/prompts/coder.ts"),
  "entities/Scope.ts": gitShow(SCOPE_FIX, "packages/core/src/entities/Scope.ts"),
  "entities/Skill.ts": gitShow(SCOPE_FIX, "packages/core/src/entities/Skill.ts"),
  "ports/FileSystem.ts": gitShow(SCOPE_FIX, "packages/core/src/ports/FileSystem.ts"),
}

// — Case 5 (HARDEST + LONGEST): the context-compaction orchestration (HEAD) —
// The most complex single module in the agent (233 lines): cache-safe context
// compression — token estimation, head+tail clipping with REVERSIBLE markers,
// structure-aware routing into `planContentCompression` (from the given
// `compactionContent.ts`), FAST-tier middle digests via the `UtilityLlm` port, a
// threshold auto-fold, AND append-time integration with the REAL `runAgentLoop`
// (materialised as fixed context — the model's `compressToolResults` must make
// the actual loop behave). A 249-line, partly property-based oracle. Its closure
// pulls in `@effect/ai` via `agentLoop.ts`, resolved by the sandbox's `@effect`
// mount (`dockerSandbox.ts`). Self-consistency verified: real module → 13/13.
const hrShow = (p: string): string => gitShow("HEAD", `packages/core/src/${p}`)
const compactionTestFull = hrShow("usecases/compaction.test.ts")
const compactionDeps: Record<string, string> = {
  "usecases/agentLoop.ts": hrShow("usecases/agentLoop.ts"),
  "usecases/compactionContent.ts": hrShow("usecases/compactionContent.ts"),
  "usecases/promptMapping.ts": hrShow("usecases/promptMapping.ts"),
  "entities/Conversation.ts": hrShow("entities/Conversation.ts"),
  "entities/AgentContext.ts": hrShow("entities/AgentContext.ts"),
  "entities/AgentHooks.ts": hrShow("entities/AgentHooks.ts"),
  "ports/LlmInfo.ts": hrShow("ports/LlmInfo.ts"),
  "ports/UtilityLlm.ts": hrShow("ports/UtilityLlm.ts"),
}

const CASES: ReadonlyArray<{ name: string; input: RepoInput }> = [
  {
    name: "structure-aware-compression",
    input: {
      files: { "compactionContent.test.ts": compactionTest },
      testPaths: ["compactionContent.test.ts"],
      canonicalTests: { "compactionContent.test.ts": compactionTest },
      prompt:
        "Implement a new file `compactionContent.ts` (pure TypeScript, no imports needed) that " +
        "compresses large coding-tool outputs for an LLM's context window, exporting " +
        "`planSearchCompression`, `planLogCompression`, and `planContentCompression`. The colocated " +
        "`compactionContent.test.ts` is the COMPLETE specification (grep-flood output grouped per file " +
        "with every file visible and a per-file cap within a char budget; Bash logs keep the head, " +
        "error blocks with their traces, deduped warnings, summary lines, and the tail; " +
        "`planContentCompression` routes search-shape from any tool but log-shape only from Bash).\n\n" +
        "Work step by step USING YOUR TOOLS — do not just describe a plan:\n" +
        "1. `read_file` compactionContent.test.ts to learn the exact API and behavior.\n" +
        "2. `write_file` compactionContent.ts with a full implementation.\n" +
        "3. Run `bun test compactionContent.test.ts` with the Bash tool, read the failures, and " +
        "`edit_file` until every test passes.\n" +
        "Do NOT modify the test file.",
    },
  },
  {
    name: "shared-token-budget",
    input: {
      files: { "tokenBudget.test.ts": tokenBudgetTest },
      testPaths: ["tokenBudget.test.ts"],
      canonicalTests: { "tokenBudget.test.ts": tokenBudgetTest },
      prompt:
        "Implement a new file `tokenBudget.ts`: a shared token-budget pool for sub-agents, exporting " +
        "`makeTokenPool`, `drainPool`, `poolExhausted`, and `usageCost` (you may import from `effect`, " +
        "e.g. `Ref`). The colocated `tokenBudget.test.ts` is the COMPLETE specification (a positive " +
        "budget makes a live pool while <= 0 disables it; usage drains the pool by billed tokens = " +
        "input + output; exhaustion at <= 0; the pool is shared by reference so a child's drain is " +
        "visible to the parent).\n\n" +
        "Work step by step USING YOUR TOOLS — do not just describe a plan:\n" +
        "1. `read_file` tokenBudget.test.ts to learn the exact API and behavior.\n" +
        "2. `write_file` tokenBudget.ts with a full implementation.\n" +
        "3. Run `bun test tokenBudget.test.ts` with the Bash tool, read the failures, and `edit_file` " +
        "until every test passes.\n" +
        "Do NOT modify the test file.",
    },
  },
  {
    name: "prompt-response-mapping",
    input: {
      // Nested layout mirroring core/src so the test's relative imports resolve:
      //   usecases/promptMapping.test.ts → ../entities/Conversation.js, ../ports/LlmInfo.js
      files: {
        "usecases/promptMapping.test.ts": promptMappingTest,
        "entities/Conversation.ts": conversationEntity,
        "ports/LlmInfo.ts": llmInfoPort,
      },
      testPaths: ["usecases/promptMapping.test.ts"],
      canonicalTests: { "usecases/promptMapping.test.ts": promptMappingTest },
      prompt:
        "Implement `usecases/promptMapping.ts` — the bridge between our persisted `AgentMessage` " +
        "(see `entities/Conversation.ts`) and a provider response, exporting EXACTLY these 11 " +
        "functions: `handoffToMessage`, `toPromptMessages`, `responseToAgentMessages`, `responseText`, " +
        "`responseReasoning`, `responseToolCalls`, `responseToolResults`, `extractUsage`, " +
        "`attachUsageToAssistant`, `assistantUsage`, and `recoverConversationStats`.\n\n" +
        "The colocated `usecases/promptMapping.test.ts` is the COMPLETE, property-based specification. " +
        "Key behaviors it pins (read it for the exact shapes):\n" +
        "- `toPromptMessages` is total and maps every message 1:1, preserving roles, parts, and the " +
        "presence of `providerOptions`.\n" +
        "- Usage embedding: `attachUsageToAssistant` is idempotent and round-trips through " +
        "`assistantUsage`; it's a no-op unless the head message is an assistant; it preserves every " +
        "prior `providerOptions` key except `efferent`. `recoverConversationStats` sums exactly the " +
        "attached usages, in order, and is total on arbitrary message arrays.\n" +
        "- `responseToAgentMessages` partitions response parts into an assistant bucket, a tool bucket, " +
        "and dropped parts.\n" +
        "- `extractUsage` is total and provider-aware: fold Anthropic `cache_read`+`cache_creation` " +
        "tokens back into `inputTokens` (both are excluded upstream); an empty anthropic blob still " +
        "folds (zeros); a null anthropic usage does NOT fold and must not throw; fall back to Gemini " +
        "`usageMetadata` when no usage blob exists; a usage-bearing finish part wins over a usage-less " +
        "one (OpenCode emits two finish parts); precedence is top-level usage > finish usage > " +
        "usageMetadata.\n" +
        "- `responseText` joins text parts; `responseReasoning` joins and trims reasoning parts; " +
        "`responseToolCalls`/`responseToolResults` pair by id and map `isFailure → !ok`; " +
        "`handoffToMessage` wraps a summary string as a user-visible system note.\n\n" +
        "Work step by step USING YOUR TOOLS — do not just describe a plan:\n" +
        "1. `read_file` usecases/promptMapping.test.ts (the spec), then `entities/Conversation.ts` (the " +
        "`AgentMessage` shape) and `ports/LlmInfo.ts` (the `TokenUsage` shape).\n" +
        "2. `write_file` usecases/promptMapping.ts with a full implementation of all 11 exports.\n" +
        "3. Run `bun test usecases/promptMapping.test.ts` with the Bash tool, read the failures, and " +
        "`edit_file` until every test passes.\n" +
        "Do NOT modify the test file, `entities/Conversation.ts`, or `ports/LlmInfo.ts`.",
    },
  },
  {
    name: "bound-scope-discovery",
    input: {
      // No test file is given — the grader is HIDDEN (restored only at grade time).
      files: {
        "usecases/discoverScopeTree.ts": scopeBuggy,
        ...scopeDeps,
      },
      testPaths: ["usecases/discoverScopeTree.test.ts"],
      canonicalTests: { "usecases/discoverScopeTree.test.ts": scopeHiddenTest },
      prompt:
        "BUG REPORT. `usecases/discoverScopeTree.ts` discovers the workspace's `SCOPE.md` tree with a " +
        "single UNBOUNDED recursive directory listing. When efferent is launched in a huge workspace — " +
        "e.g. `/` (a container's default workdir) — it walks the ENTIRE filesystem and the process is " +
        "OOM-killed before it can print anything. Boot must stay cheap and ALWAYS terminate.\n\n" +
        "TASK: fix `usecases/discoverScopeTree.ts` to bound the walk. Do NOT change any other discovery " +
        "behaviour — frontmatter stripping, name-sorted children, nearest-enclosing nesting, " +
        "first-name-wins dedupe, and the exported `getScopePromptBody` must all keep working exactly as " +
        "they do now. Requirements for the fix:\n" +
        "- Replace the recursive listing with a bounded BREADTH-FIRST walk: one NON-recursive " +
        "`FileSystem.list` per directory. BFS order matters — visit shallower directories first, so a " +
        "shallow scope wins the existing first-name-seen dedupe.\n" +
        "- Add an optional 4th parameter (right after `now`): " +
        "`bounds?: { maxDepth?: number; maxDirs?: number }`. When omitted, default maxDepth to 8 and " +
        "maxDirs to 10000. `maxDepth` caps how deep the walk descends (the workspace root is depth 0); " +
        "`maxDirs` caps the total number of directories listed.\n" +
        "- Hitting EITHER cap must yield a PARTIAL result (whatever was found so far) and must NEVER " +
        "fail — boot has to survive `/`.\n" +
        "- NEVER descend into hidden directories (basename starting with `.`) or `node_modules` — scopes " +
        "under them are skipped.\n" +
        "- Keep the existing resilience: a failed or empty `list` (EACCES, a vanished dir) just prunes " +
        "that branch; it must not fail the whole walk. When a listing entry's path is relative, resolve " +
        "it against the directory being listed.\n\n" +
        "There is intentionally NO test file in the workspace — implement the fix from this report and " +
        "the surrounding code. Work step by step USING YOUR TOOLS: `read_file` " +
        "`usecases/discoverScopeTree.ts` (the buggy walk) and `ports/FileSystem.ts` (the `list` signature " +
        "and `DirEntry` shape), reason about the change, then `edit_file`/`write_file` it. You MAY write " +
        "your own scratch test to sanity-check, but you will be graded by a hidden test.\n" +
        "Do NOT modify `ports/FileSystem.ts`, `entities/Scope.ts`, `entities/Skill.ts`, " +
        "`prompts/coder.ts`, or `usecases/discoverInstructionFiles.ts`.",
    },
  },
  {
    // Same bug, same HIDDEN oracle as `bound-scope-discovery` — but an
    // UNDER-SPECIFIED issue. We give only the symptom + the one thing the grader
    // structurally needs (the `bounds` parameter shape, which the hidden test
    // calls positionally) and withhold the four edge behaviours the test checks:
    // pruning hidden/`node_modules`, BFS shallow-first dedupe ordering,
    // partial-never-fail on a cap, and resolving relative listing entries. This
    // is the SWE-bench reality — real issues are vague; the model must rediscover
    // the requirements. Spec detail is the ONLY variable vs the case above, so
    // the score delta isolates "did the model infer the unstated requirements".
    // Expect graceful partial credit (`testRatio`) rather than a clean 1.00.
    name: "bound-scope-discovery-terse",
    input: {
      files: {
        "usecases/discoverScopeTree.ts": scopeBuggy,
        ...scopeDeps,
      },
      testPaths: ["usecases/discoverScopeTree.test.ts"],
      canonicalTests: { "usecases/discoverScopeTree.test.ts": scopeHiddenTest },
      prompt:
        "BUG REPORT. efferent OOM-crashes at boot when it's launched in a very large workspace — for " +
        "example `/` (a container's default working directory). The culprit is " +
        "`usecases/discoverScopeTree.ts`: it discovers the workspace's `SCOPE.md` tree by listing the " +
        "WHOLE directory tree in one shot, so in a huge workspace it never finishes and the process is " +
        "killed before printing anything.\n\n" +
        "Fix `usecases/discoverScopeTree.ts` so boot stays cheap and ALWAYS terminates, without changing " +
        "which scopes are discovered in an ordinary project. Make the traversal bounded and configurable: " +
        "add an optional final parameter `bounds?: { maxDepth?: number; maxDirs?: number }` (defaults: " +
        "maxDepth 8, maxDirs 10000) that limits how deep and how many directories discovery visits. " +
        "Work out the rest of what 'bounded and well-behaved' has to mean from the existing code, the " +
        "`FileSystem` port, and good engineering judgement — there are details this report does not spell " +
        "out.\n\n" +
        "There is intentionally NO test file in the workspace — implement the fix from this report and the " +
        "surrounding code. Work step by step USING YOUR TOOLS: `read_file` `usecases/discoverScopeTree.ts` " +
        "and `ports/FileSystem.ts`, reason about the change, then `edit_file`/`write_file` it. You MAY " +
        "write your own scratch test to sanity-check, but you will be graded by a hidden test.\n" +
        "Do NOT modify `ports/FileSystem.ts`, `entities/Scope.ts`, `entities/Skill.ts`, " +
        "`prompts/coder.ts`, or `usecases/discoverInstructionFiles.ts`.",
    },
  },
  {
    name: "context-compaction",
    input: {
      files: {
        ...compactionDeps,
        "usecases/compaction.test.ts": compactionTestFull, // visible spec
      },
      testPaths: ["usecases/compaction.test.ts"],
      canonicalTests: { "usecases/compaction.test.ts": compactionTestFull },
      prompt:
        "Implement `usecases/compaction.ts` — the agent's CACHE-SAFE context-compression module — " +
        "exporting at least: `estimateTokens`, `DEFAULT_TOOL_RESULT_MAX_CHARS`, `planClip`, `renderClip`, " +
        "`shouldAutoHandoff`, and `compressToolResults`. The colocated `usecases/compaction.test.ts` is the " +
        "COMPLETE specification (it includes property-based tests and integration tests that drive the " +
        "REAL `runAgentLoop`).\n\n" +
        "Behaviors the test pins (read it for the exact marker strings and numbers):\n" +
        "- `estimateTokens(chars)` ≈ chars/4. `DEFAULT_TOOL_RESULT_MAX_CHARS` is the default budget.\n" +
        "- `planClip(text, maxChars)` returns undefined when the text fits, else a plan that keeps a HEAD " +
        "and a TAIL of the text (a lossless split); `renderClip(plan, toolName, summary?)` renders the " +
        "kept head+tail joined by a single REVERSIBLE marker that names roughly how many tokens were " +
        "dropped and how to get them back, weaving in the optional `summary` when given.\n" +
        "- `shouldAutoHandoff(...)` fires only at/above the threshold percent and never with an unknown " +
        "context window or a 0 percent.\n" +
        "- `compressToolResults(messages, ...)` walks the messages and, for any oversized STRING inside a " +
        "tool-result output, replaces it with a compressed form: grep-shaped output is routed to the " +
        "structure-aware `planContentCompression` (imported from `./compactionContent.js`, already present) " +
        "rather than blindly clipped; small outputs and non-tool / string-content messages pass through " +
        "UNCHANGED. When a `UtilityLlm` service is in context, the dropped middle gets a FAST digest woven " +
        "into the marker and its usage is reported on the result (`helperUsage`); a summarizer failure " +
        "degrades to the plain marker and must NEVER fail the pass. The TUI sees the RAW result — only the " +
        "persisted tail is compressed (the `runAgentLoop` integration tests assert this).\n\n" +
        "Work step by step USING YOUR TOOLS — this is a large module, do not just describe a plan:\n" +
        "1. `read_file` usecases/compaction.test.ts (the spec), then `usecases/compactionContent.ts` for the " +
        "`planContentCompression` API and `ports/UtilityLlm.ts` for the digest service shape.\n" +
        "2. `write_file` usecases/compaction.ts with a full implementation.\n" +
        "3. Run `bun test usecases/compaction.test.ts` with the Bash tool, read the failures, and " +
        "`edit_file` until EVERY test passes.\n" +
        "Do NOT modify the test file or any of the provided dependency files (`agentLoop.ts`, " +
        "`compactionContent.ts`, `promptMapping.ts`, the entities, or the ports).",
    },
  },
]

export const repoTasksEval = defineEval<RepoInput, RepoRun, Record<string, never>, EvalEnv>({
  name: "repo-tasks",
  description: "implement a real past feature from its shipped test (Docker-sandboxed, parallel)",
  threshold: 0.5,
  concurrency: 2, // each case gets its own container → safe parallelism
  data: CASES.map((c) => ({ name: c.name, input: c.input, expected: {} })),
  task: (input) =>
    runRepoTask(input.files, input.prompt, {
      testPaths: input.testPaths,
      canonicalTests: input.canonicalTests,
    }),
  scorers: [
    predicate("tests_pass", ({ output }) => output.allPass),
    fromEffect("test_ratio", ({ output }) => Effect.succeed(output.testRatio)),
  ],
})
