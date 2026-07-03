import { Effect, Ref } from "effect"
import {
  ApprovalAllowAllLive,
  buildScopeRuntime,
  ConversationStore,
  discoverScopeTree,
  runAgent,
  type AgentEvent,
  type AgentHooks,
} from "@xandreed/sdk-core"
import { UnavailableVerifierLive } from "@xandreed/sdk-adapters"
import { coderAgentConfig } from "efferent/usecases/coderAgentConfig.js"
import { webAgentPrompt } from "efferent/prompts/web.js"
import type { InstructionFile } from "efferent/usecases/discoverInstructionFiles.js"
import { mergeCanvasEntry } from "efferent/web/model.js"
import { ACTION_UI_PATH, RENDER_UI_KIT_DOC, render, sanitizeHtml, UI_ID_FIELD } from "@xandreed/web"
import { defineEval } from "../framework/Eval.js"
import { predicate, qualityRubric } from "../framework/scorers.js"
import { withTempWorkspace } from "../support/workspace.js"
import type { EvalEnv } from "../env.js"

/**
 * **Generative-UI PAGE quality** (`render_ui`, the `efferent web` canvas).
 * Runs the REAL web agent (webAgentPrompt + webUi toolkit + kit doc — exactly
 * what `efferent web` composes), captures the `ui_render` events, folds them
 * into pages with the driver's own merge, and grades the result across the
 * platform's use cases: a landing page, an architecture-with-visuals ask (the
 * 0fb4b8eb regression — the agent once wrote docs/architecture.md to disk and
 * said "view it in a Markdown renderer"), a data breakdown, and an
 * interactive exercise.
 *
 *   - deterministic contract scorers — rendered a page at all; survives the
 *     sanitizer UNCHANGED; page-scale structure (hero/cols/tables/stats/h1);
 *     ≥4 ef-* kit classes; mermaid present where the case demands a diagram;
 *     **no file punt** (render_ui actually called, no .md/.html written in
 *     lieu of rendering, no "view it elsewhere" in the final text);
 *   - an anchored LLM judge on the page itself — the "is it GOOD" half.
 *
 * Page-scale baseline (2026-07-02, opencode:deepseek-v4-flash, 4 cases × 3):
 * mean 0.93, pass 100%, pass^k 100% — `no_file_punt` 1.00 on EVERY case
 * (architecture-visual 0.98: the regression is dead); judge 0.75–1.00;
 * sanitizer_clean is the soft spot (0.33 on landing/data — occasional
 * stripped markup, rendered with the dropped-chip). Retired card-scale
 * baseline (pre-pages, same day): mean 0.92, pass 100%.
 */

interface WebUiInput {
  readonly prompt: string
  /** Files seeding the temp workspace (the architecture case reads real code). */
  readonly files?: Record<string, string>
}
interface WebUiExpected {
  /** Must the page carry a working post-back form? */
  readonly interactive: boolean
  /** Must the page embed at least one mermaid diagram? */
  readonly mermaid: boolean
  /** What good looks like for THIS page (feeds the judge rubric). */
  readonly rubric: string
}

interface UiPage {
  readonly id: string
  readonly title?: string
  readonly html: string
}
export interface WebUiRun {
  /** Folded pages (same merge as the live driver) in creation order. */
  readonly pages: ReadonlyArray<UiPage>
  /** The page the last render touched — what the judge grades. */
  readonly graded: UiPage | undefined
  readonly toolNames: ReadonlyArray<string>
  /** Paths passed to write_file/edit_file (feeds the no-punt scorer). */
  readonly writes: ReadonlyArray<string>
  readonly finalText: string
}

/** Stand up the web-mode root (webAgentPrompt + render_ui + kit doc) over a
 *  temp workspace, run one prompt, fold the ui_render events into pages. The
 *  loop stops at quiescence: a turn ends with pages present and none added
 *  during it (so an append-streamed page isn't cut mid-build). */
const runWebUiAgent = (
  prompt: string,
  files: Record<string, string> = {},
): Effect.Effect<WebUiRun, unknown, EvalEnv> =>
  withTempWorkspace(files, (dir) =>
    Effect.gen(function* () {
      const kitDoc: ReadonlyArray<InstructionFile> = [
        { path: "<web-ui-kit>", content: RENDER_UI_KIT_DOC },
      ]
      const prompt0 = webAgentPrompt(dir, new Date(), [], kitDoc, [], [], undefined, [])
      const rootScope = yield* discoverScopeTree(dir, () => prompt0.text)
      const rendersRef = yield* Ref.make<
        ReadonlyArray<{ id: string; title?: string; html: string; mode: "replace" | "append" }>
      >([])
      const toolsRef = yield* Ref.make<ReadonlyArray<string>>([])
      const writesRef = yield* Ref.make<ReadonlyArray<string>>([])
      const runtime = buildScopeRuntime(rootScope, {
        skills: [],
        memory: [],
        agents: [],
        tools: [],
        allowBash: false,
        webUi: true,
        onBusEvent: (e: AgentEvent) =>
          e.type === "ui_render"
            ? Ref.update(rendersRef, (a) => [
                ...a,
                {
                  id: e.id,
                  ...(e.title !== undefined ? { title: e.title } : {}),
                  html: e.html,
                  mode: e.mode,
                },
              ])
            : Effect.void,
      })
      const config = coderAgentConfig(rootScope, runtime, prompt0)
      const store = yield* ConversationStore
      const id = yield* store.create(dir)
      let atTurnStart = 0
      const hooks: AgentHooks = {
        onTurnStart: () =>
          Ref.get(rendersRef).pipe(
            Effect.map((a) => {
              atTurnStart = a.length
            }),
            Effect.asVoid,
          ),
        onBeforeToolCall: (e) =>
          Effect.gen(function* () {
            yield* Ref.update(toolsRef, (a) => [...a, e.toolName])
            if (e.toolName === "write_file" || e.toolName === "edit_file") {
              const p =
                typeof e.args === "object" && e.args !== null
                  ? (e.args as { path?: unknown }).path
                  : undefined
              if (typeof p === "string") yield* Ref.update(writesRef, (a) => [...a, p])
            }
            return { action: "continue" } as const
          }),
        // Quiescence: pages exist and this turn added none → the build settled.
        onShouldStopAfterTurn: () =>
          Ref.get(rendersRef).pipe(Effect.map((a) => a.length > 0 && a.length === atTurnStart)),
      }
      const result = yield* runAgent(config, id, prompt, hooks, dir).pipe(
        Effect.provide(runtime.handlerLayer),
        Effect.provide(ApprovalAllowAllLive),
        Effect.provide(UnavailableVerifierLive),
      )
      const renders = yield* Ref.get(rendersRef)
      const toolNames = yield* Ref.get(toolsRef)
      const writes = yield* Ref.get(writesRef)
      // Fold with the DRIVER's merge — the eval grades what the browser shows.
      let pages: ReadonlyArray<UiPage> = []
      for (const r of renders) pages = mergeCanvasEntry(pages, r).canvas
      const lastId = renders[renders.length - 1]?.id
      return {
        pages,
        graded: pages.find((p) => p.id === lastId),
        toolNames,
        writes,
        finalText: result.finalText,
      }
    }),
  )

const CASES = [
  {
    name: "landing-page",
    input: {
      prompt:
        "Build a landing page for 'Driftline', a fictional open-source flight-tracking library. " +
        "I want a proper page: a hero with the name, a one-line pitch and a call-to-action button; " +
        "a three-column features section; a stats row (stars, downloads, contributors — invent " +
        "plausible numbers); and a short get-started section with an install command in a code block.",
    },
    expected: {
      interactive: false,
      mermaid: false,
      rubric:
        "A real landing page, not a chat card: a hero (large title + one-line pitch + CTA button); " +
        "a 3-column features section with distinct plausible features; a stats row with three " +
        "labelled numbers; a get-started section with an install command in a pre/code block; " +
        "coherent ef-* page-layout classes (hero/cols/features/stats or grid equivalents); no " +
        "lorem-ipsum, no broken markup.",
    },
  },
  {
    // A visual explanation from KNOWLEDGE (the web agent has no filesystem) —
    // the mermaid + no-file-punt case, non-code subject.
    name: "concept-diagram",
    input: {
      prompt: "explain how the OAuth 2.0 authorization-code flow works, with a diagram",
    },
    expected: {
      interactive: false,
      mermaid: true,
      rubric:
        "A page explaining the OAuth 2.0 authorization-code flow: at least one Mermaid diagram " +
        "(mermaid source in a pre block — a sequence or flow diagram) showing the real actors " +
        "(user/browser, client app, authorization server, resource server) and the real steps " +
        "(authorize redirect → code → token exchange → access token → resource); a short prose " +
        "explanation alongside; ef-* page structure. Technically accurate, not hand-wavy; it must " +
        "not tell the user to view something elsewhere.",
    },
  },
  {
    name: "data-breakdown",
    input: {
      prompt:
        "Here are our monthly cloud costs — break down where the money goes and what's growing. " +
        "Give me something I can look at, not a wall of text. " +
        "January: compute $4200, storage $1100, egress $600. " +
        "February: compute $4600, storage $1150, egress $900. " +
        "March: compute $5100, storage $1200, egress $1400.",
    },
    expected: {
      interactive: false,
      mermaid: true,
      rubric:
        "A data-breakdown page from the PROVIDED numbers only (no invented data): a table with the " +
        "actual figures; computed totals and/or percentages that are ARITHMETICALLY CORRECT " +
        "(totals: Jan 5900, Feb 6650, Mar 7700); a clear callout or steps explaining what's " +
        "growing (egress is the standout: +133% Jan→Mar); a mermaid pie or xychart of the data; " +
        "ef-* structure (stats/table/steps/callout).",
    },
  },
  {
    name: "exercise-js-output",
    input: {
      prompt:
        "You are an education agent. Use render_ui to render a practice exercise (id 'js-output') " +
        "showing a short JavaScript snippet in a code block and asking what it logs; include a text " +
        "input named answer and a submit button. Then reply 'done'.",
    },
    expected: {
      interactive: true,
      mermaid: false,
      rubric:
        "A practice-exercise page: a short, syntactically valid JS snippet in a pre/code block whose " +
        "output is well-defined; a clear question; a text input named answer plus a submit button wired " +
        "for post-back; ef-* kit classes throughout.",
    },
  },
]

/** The sanitized html — what the browser actually renders. */
const cleanHtml = (page: UiPage | undefined): string =>
  page === undefined ? "" : render(sanitizeHtml(page.html).html)

/** "Go view it elsewhere" phrasings — the exact 0fb4b8eb failure mode. */
const PUNT_RE =
  /view (it|this|them) in|open .*\.(md|html)|markdown (renderer|viewer|preview)|vs ?code|on github/i

export const webUiEval = defineEval<WebUiInput, WebUiRun, WebUiExpected, EvalEnv>({
  name: "web-ui",
  description:
    "render_ui PAGE quality across use cases: sanitizer-clean, page-scale structure, mermaid, no file punt, judged",
  threshold: 0.6,
  data: CASES,
  task: (input) => runWebUiAgent(input.prompt, input.files ?? {}),
  scorers: [
    predicate("rendered_a_page", ({ output }) => output.pages.length > 0),
    // Inside the allowed vocabulary: nothing for the sanitizer to strip.
    predicate(
      "sanitizer_clean",
      ({ output }) =>
        output.graded !== undefined && sanitizeHtml(output.graded.html).dropped.length === 0,
    ),
    // Counts only DOCUMENTED kit classes — hallucinated Tailwind-style ef-*
    // utilities (ef-text-xl, ef-py-6…) style nothing and must not score.
    predicate(
      "on_design_system",
      ({ output }) =>
        output.graded !== undefined &&
        (output.graded.html.match(
          /\bef-(band|split|aside|media|hero|section|section-alt|section-dark|container|cols-\d|grid|grid-cols-\d|col|flex|span-2|features|feature|stats|stat|steps|step|figure|card|callout|stack|row|grid-\d|table|btn|badge|title|text|muted|lede|display|eyebrow|divider|field|label|input|textarea|select|choice|kbd|code|progress|img|mermaid|tight|loose)\b/g,
        ) ?? []).length >= 4,
    ),
    // Page-scale structure: at least two of the page primitives.
    predicate("page_structure", ({ output }) => {
      const html = cleanHtml(output.graded)
      const hits = [
        /<h1|<h2/.test(html),
        /ef-hero|ef-band/.test(html),
        /ef-cols-|ef-grid-|ef-features/.test(html),
        /ef-table|<table/.test(html),
        /ef-stat/.test(html),
      ].filter(Boolean).length
      return hits >= 2
    }),
    // A REAL page, not a flat prose column: at least one side-by-side layout —
    // the named recipes OR the common-framework aliases the model reaches for
    // (ef-grid / ef-grid-cols-N / ef-flex). The "still feels like a list" fix.
    predicate(
      "multi_column",
      ({ output }) =>
        /\bef-(split|media|cols-\d|grid-cols-\d|grid|flex|features|stats)\b/.test(cleanHtml(output.graded)),
    ),
    // The diagram contract, where the case demands one.
    predicate("mermaid_present", ({ output, expected }) => {
      if (!expected.mermaid) return true
      const html = cleanHtml(output.graded)
      const block = /<pre[^>]*class="[^"]*ef-mermaid[^"]*"[^>]*>([\s\S]*?)<\/pre>/.exec(html)
      return (
        block !== null &&
        /\b(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|pie|xychart)/.test(
          block[1] ?? "",
        )
      )
    }),
    // The 0fb4b8eb regression: rendered in the UI, not punted to disk.
    predicate("no_file_punt", ({ output }) => {
      if (!output.toolNames.includes("render_ui")) return false
      const wroteDoc = output.writes.some((p) => /\.(md|html)$/i.test(p))
      if (wroteDoc && output.pages.length === 0) return false
      return !PUNT_RE.test(output.finalText)
    }),
    // The post-back contract, measured on what SURVIVES sanitization.
    predicate("interactive_contract", ({ output, expected }) => {
      if (!expected.interactive) return true
      const html = cleanHtml(output.graded)
      return (
        html.includes(`hx-post="${ACTION_UI_PATH}"`) &&
        html.includes(`name="${UI_ID_FIELD}"`) &&
        /<button|type="submit"/.test(html)
      )
    }),
    qualityRubric("ui_quality", ({ output, expected }) => ({
      rubric: expected.rubric,
      output:
        output.graded === undefined
          ? "(no page was rendered)"
          : `TITLE: ${output.graded.title ?? "(none)"}\nSANITIZED PAGE HTML:\n${cleanHtml(output.graded)}`,
    })),
  ],
})
