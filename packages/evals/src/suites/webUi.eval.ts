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
 * Runs the REAL web agent (webAgentPrompt + the content-only toolkit + the
 * Tailwind kit doc — exactly what `efferent web` composes), captures the
 * `ui_render` events, folds them into pages with the driver's own merge, and
 * grades the result across the platform's use cases: a landing page, a
 * concept explainer with a diagram, a data breakdown, and an interactive
 * exercise. Pages are styled with real Tailwind (the model's native output;
 * the web UI ships the Tailwind runtime), so the scorers check Tailwind craft,
 * not a bespoke kit.
 *
 *   - deterministic contract scorers — rendered a page; survives the sanitizer
 *     UNCHANGED (no inline styles/scripts to strip); actually styled with
 *     Tailwind utilities; a genuine multi-column grid; page-scale structure;
 *     mermaid present where the case demands a diagram; **no file punt**;
 *   - an anchored LLM judge on the page itself — the "is it GOOD, and does it
 *     look modern" half.
 *
 * Baseline: pending a re-run on the Tailwind design system (the pre-Tailwind
 * ef-* baseline is retired). Quality of the visual craft tracks model
 * capability — a stronger model produces markedly better Tailwind pages.
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
        "a modern Tailwind-styled page — a real hero, a multi-column grid of features, spacing/typography/color that reads polished; no " +
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
        "explanation alongside; a modern Tailwind-styled layout (hero, sections, a grid, a styled card). Technically accurate, not hand-wavy; it must " +
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
        "a modern Tailwind layout (a stats grid, a styled table, cards).",
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
        "for post-back; styled with Tailwind (spacing, rounded, a clear submit button).",
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
    // Actually styled with Tailwind (the model's native output) — spacing,
    // color, layout, depth. A bare page with no utilities scores 0.
    predicate("on_design_system", ({ output }) => {
      const html = output.graded?.html ?? ""
      const utils = [
        /\bbg-(gradient|slate|zinc|neutral|indigo|violet|purple|emerald|rose|blue|sky|white\/)/,
        /\btext-(4xl|5xl|3xl|2xl|xl|lg|slate|white|indigo|zinc)/,
        /\b(grid|flex)\b/,
        /\brounded-(xl|2xl|3xl|lg|full)/,
        /\bshadow-(lg|xl|2xl|md)/,
        /\b(px|py|p|gap|space-y|space-x|mt|mb|mx)-\d/,
        /\bmax-w-\w+/,
        /\bborder(-\w+)?\b/,
      ].filter((re) => re.test(html)).length
      return utils >= 5
    }),
    // Page-scale structure: a big hero heading, a centered container, sections,
    // a grid — at least two.
    predicate("page_structure", ({ output }) => {
      const html = cleanHtml(output.graded)
      const hits = [
        /text-(4xl|5xl|3xl)/.test(html),
        /max-w-\w+/.test(html),
        /\bpy-\d{2}\b|\bpy-1[0-9]\b/.test(html),
        /grid-cols-|md:grid-cols-/.test(html),
        /<table|rounded-2xl/.test(html),
      ].filter(Boolean).length
      return hits >= 2
    }),
    // A REAL page, not a flat prose column: at least one genuine multi-column
    // layout (a Tailwind grid with 2+ columns, or a responsive grid).
    predicate("multi_column", ({ output }) =>
      /\b(grid-cols-[234]|md:grid-cols-[234]|lg:grid-cols-[234]|sm:grid-cols-[234])\b/.test(
        cleanHtml(output.graded),
      ),
    ),
    // The diagram contract, where the case demands one.
    predicate("mermaid_present", ({ output, expected }) => {
      if (!expected.mermaid) return true
      const html = cleanHtml(output.graded)
      const block = /<pre[^>]*class="[^"]*\bmermaid\b[^"]*"[^>]*>([\s\S]*?)<\/pre>/.exec(html)
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
