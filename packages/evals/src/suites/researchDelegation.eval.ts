import { defineEval } from "../framework/Eval.js"
import { runScenario, type ScenarioRun } from "../support/scenarioRun.js"
import {
  researchReadOnlyScore,
  routingScore,
  type RoutingExpectation,
} from "../support/scenarioScorers.js"
import type { EvalEnv } from "../env.js"

/**
 * **Research delegation** — the complaint this suite encodes (the user's,
 * verbatim): *"the initial research that could be quite sped up by using the
 * swarm is always running in the master session instead."*
 *
 * A BROAD investigation — getting oriented in an unfamiliar codebase, mapping
 * how several modules work and connect, tracing a request end-to-end — is the
 * textbook case for the **research fleet**: reading never conflicts, so parallel
 * read-only researchers are pure speed-up (and they keep the root's context
 * clean). Yet the root does it serially: the `# When to delegate` policy opens
 * with *"Do the investigating … yourself — that's the fast path"* and offers no
 * "broad reading fans out" path the way `# Writing code` exists for code.
 *
 * Unlike `swarm` / `research-efficiency` — which *command* the model to
 * `run_agent({ agent: "research-coordinator" })` and only check the fleet
 * finishes — these prompts are NATURAL: no "delegate", "spawn", "fleet",
 * "sub-agent". We measure the ROOT's own routing decision from the trajectory
 * (`routingScore`, deterministic, no judge):
 *   - a broad investigation  → `shouldDelegate: true`, `minSpawns: 2` (actually fans out)
 *   - a narrow single-file Q&A → `shouldDelegate: false` (stays on the root — the over-delegation guard)
 *
 * REQUIRES the real fleet roster (`includeFleet: true`) — without it the
 * `# When to delegate` policy is never emitted and `run_agent({ agent:
 * "research-coordinator" })` fails `UnknownAgent`. Run it on a real setup:
 *   bun run eval researchDelegation --config dataset/configs/code-tier.json --samples 2
 *
 * The point of the suite: BEFORE the prompt fix the broad cases score ~0 (the
 * root reads everything itself), the narrow cases score 1 — a clean,
 * reproducible failure. AFTER, the broad cases fan out to the research fleet and
 * the narrow cases still stay direct.
 */

interface Input {
  readonly files: Record<string, string>
  readonly prompt: string
}
interface Expected {
  readonly routing: RoutingExpectation
  /** Fix 3 guard: a research investigation must write NOTHING fleet-wide, even
   *  when the prompt says "fix" — it recommends, the root implements. */
  readonly researchReadOnly?: boolean
}

// A small but multi-domain service: three INDEPENDENT modules (auth, billing,
// notifications) plus a thin server layer that wires them. Reading all of it to
// answer a "map the whole thing" question is real work that parallelises
// cleanly — one researcher per module/layer — which is exactly when the swarm
// wins over a serial root read.
const REPO: Record<string, string> = {
  "src/auth/session.ts":
    "import { findUserByToken } from './store'\n" +
    "export interface Session { readonly userId: string; readonly scopes: ReadonlyArray<string> }\n" +
    "// Resolve a bearer token to a session. Tokens are opaque; the store maps them to users.\n" +
    "export const resolveSession = async (token: string): Promise<Session | null> => {\n" +
    "  const user = await findUserByToken(token)\n" +
    "  if (user === null) return null\n" +
    "  return { userId: user.id, scopes: user.scopes }\n" +
    "}\n",
  "src/auth/store.ts":
    "export interface User { readonly id: string; readonly scopes: ReadonlyArray<string> }\n" +
    "const TOKENS = new Map<string, User>()\n" +
    "export const findUserByToken = async (t: string): Promise<User | null> => TOKENS.get(t) ?? null\n" +
    "export const issueToken = (token: string, user: User): void => { TOKENS.set(token, user) }\n",
  "src/billing/charge.ts":
    "import { recordLedger } from './ledger'\n" +
    "// A charge is in integer cents; we never use floats for money.\n" +
    "export const charge = async (userId: string, cents: number): Promise<{ ok: boolean }> => {\n" +
    "  if (cents <= 0) return { ok: false }\n" +
    "  await recordLedger(userId, cents)\n" +
    "  return { ok: true }\n" +
    "}\n",
  "src/billing/ledger.ts":
    "interface Entry { readonly userId: string; readonly cents: number; readonly at: number }\n" +
    "const ENTRIES: Array<Entry> = []\n" +
    "export const recordLedger = async (userId: string, cents: number): Promise<void> => {\n" +
    "  ENTRIES.push({ userId, cents, at: 0 })\n" +
    "}\n" +
    "export const balanceCents = (userId: string): number =>\n" +
    "  ENTRIES.filter((e) => e.userId === userId).reduce((s, e) => s + e.cents, 0)\n",
  "src/notifications/send.ts":
    "import { renderTemplate } from './templates'\n" +
    "export type Channel = 'email' | 'sms'\n" +
    "// Notifications are fire-and-forget; a failed send is logged, never thrown.\n" +
    "export const notify = async (channel: Channel, to: string, template: string, data: Record<string, string>): Promise<void> => {\n" +
    "  const body = renderTemplate(template, data)\n" +
    "  console.log(`[notify:${channel}] ${to} ${body}`)\n" +
    "}\n",
  "src/notifications/templates.ts":
    "const TEMPLATES: Record<string, string> = {\n" +
    "  welcome: 'Welcome, {{name}}!',\n" +
    "  receipt: 'You were charged {{amount}}.',\n" +
    "}\n" +
    "export const renderTemplate = (name: string, data: Record<string, string>): string =>\n" +
    "  (TEMPLATES[name] ?? '').replace(/{{(\\w+)}}/g, (_, k: string) => data[k] ?? '')\n",
  "src/server/router.ts":
    "import { withAuth } from './middleware'\n" +
    "import { handleCharge, handleWelcome } from './handlers'\n" +
    "// Minimal route table: method+path → handler, each wrapped by the auth middleware.\n" +
    "export const routes = {\n" +
    "  'POST /charge': withAuth(handleCharge),\n" +
    "  'POST /welcome': withAuth(handleWelcome),\n" +
    "}\n",
  "src/server/middleware.ts":
    "import { resolveSession, type Session } from '../auth/session'\n" +
    "export type Handler = (session: Session, body: Record<string, unknown>) => Promise<unknown>\n" +
    "// Pull the bearer token, resolve a session, 401 if absent — then call the handler.\n" +
    "export const withAuth = (h: Handler) => async (token: string, body: Record<string, unknown>) => {\n" +
    "  const session = await resolveSession(token)\n" +
    "  if (session === null) return { status: 401 }\n" +
    "  return h(session, body)\n" +
    "}\n",
  "src/server/handlers.ts":
    "import { charge } from '../billing/charge'\n" +
    "import { notify } from '../notifications/send'\n" +
    "import type { Session } from '../auth/session'\n" +
    "// Handlers tie the modules together: charge → receipt notification; welcome → email.\n" +
    "export const handleCharge = async (s: Session, body: Record<string, unknown>) => {\n" +
    "  const cents = Number(body.cents ?? 0)\n" +
    "  const res = await charge(s.userId, cents)\n" +
    "  if (res.ok) await notify('email', s.userId, 'receipt', { amount: String(cents) })\n" +
    "  return res\n" +
    "}\n" +
    "export const handleWelcome = async (s: Session) => {\n" +
    "  await notify('email', s.userId, 'welcome', { name: s.userId })\n" +
    "  return { status: 200 }\n" +
    "}\n",
}

const CASES: ReadonlyArray<{ name: string; input: Input; expected: Expected }> = [
  {
    // BROAD — three independent domains to understand at once. The natural
    // decomposition is one researcher per module → fan out. (No delegation hint.)
    name: "broad-map-modules",
    input: {
      files: REPO,
      prompt:
        "I just inherited this service and need to get oriented fast. Read the code and give me a clear map of how the three modules — auth, billing, and notifications — each work, and how they fit together. Cover each module's responsibility and the key functions.",
    },
    expected: { routing: { shouldDelegate: true, minSpawns: 2 } },
  },
  {
    // BROAD — trace a request end-to-end across four layers (router → middleware
    // → handlers → the modules they call). Multi-file, multi-stage investigation.
    name: "broad-request-flow",
    input: {
      files: REPO,
      prompt:
        "Walk me through how a `POST /charge` request flows through this server end to end — the router, the auth middleware, the handler, and everything it touches in the billing and notifications modules. Read across src/ and explain each stage and how they connect.",
    },
    expected: { routing: { shouldDelegate: true, minSpawns: 2 } },
  },
  {
    // NARROW — one function in one named file. The over-delegation guard: this
    // must stay on the root, no fleet.
    name: "narrow-single-function",
    input: {
      files: REPO,
      prompt:
        "In src/billing/charge.ts, what does `charge` return when called with a negative `cents` value? Read that one file and answer in a sentence.",
    },
    expected: { routing: { shouldDelegate: false } },
  },
  {
    // NARROW — a focused lookup in one file. Also must stay direct.
    name: "narrow-named-lookup",
    input: {
      files: REPO,
      prompt:
        "What templates are defined in src/notifications/templates.ts, and what placeholder does each use? Read that file and list them.",
    },
    expected: { routing: { shouldDelegate: false } },
  },
  {
    // BROAD "find AND FIX" — the Fix 3 guard. The task says "fix", but a research
    // investigation must INVESTIGATE and RECOMMEND, never write. If it delegated
    // to the research fleet, that fleet must produce ZERO writes (no write_file/
    // edit_file/Bash) — implementation is the root's call in a fresh turn.
    name: "broad-find-and-fix-stays-readonly",
    input: {
      files: REPO,
      prompt:
        "Investigate the auth, billing, and notifications modules for bugs and inconsistencies across all three, and as a senior architect propose a plan to fix them.",
    },
    expected: { routing: { shouldDelegate: true, minSpawns: 2 }, researchReadOnly: true },
  },
]

export const researchDelegationEval = defineEval<Input, ScenarioRun, Expected, EvalEnv>({
  name: "researchDelegation",
  description:
    "natural broad investigations fan out to the research fleet (parallel readers); a narrow single-file lookup stays on the root",
  threshold: 0.6,
  // A full real fleet run per case (the root may spawn the research-coordinator,
  // which fans out researchers) → don't fan the cases out on top of that.
  concurrency: 1,
  data: CASES,
  task: (input) => runScenario(input.files, input.prompt, { includeFleet: true }),
  scorers: [routingScore("routing"), researchReadOnlyScore("research_read_only")],
})
