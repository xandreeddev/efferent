import type { ConversationId } from "@xandreed/sdk-core"
import { createTuiStore } from "../state/store.js"
import type { TuiContext } from "../state/store.js"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"

/**
 * A seeded `TuiContext` for the showcase — the REAL `createTuiStore` (so the
 * whole TUI renders exactly as it does in the app) with a short representative
 * session + realistic stats, plus the REAL UI→Effect `run` bridge so store-backed
 * commands actually execute (`:theme`/`:settings`/`:model`/`v`/…). `run` is wired
 * by `modes/showcase.ts` to a runtime over `AppLive` sandboxed to a throwaway
 * `EFFERENT_HOME` — no real config is touched, and with no credentials the LLM is
 * never reached, so `submit`/`interrupt`/`resolveApproval` stay no-ops. `onExit`
 * backs `ctx.exit`, so the app's `:exit` / Ctrl-C ×2 quit the showcase.
 */
export const makeStubCtx = (opts: {
  readonly run: TuiContext["run"]
  readonly onExit: () => void
}): TuiContext => {
  const conversationId = "00000000-0000-0000-0000-000000000000" as unknown as ConversationId
  const store = createTuiStore({
    status: {
      modelId: "claude-opus-4-8",
      cwd: "/home/you/project",
      storage: "sqlite",
      effort: "high",
    },
    conversationId,
    footer: "",
    sidePane: {
      ...emptySidePane,
      skillsLoaded: ["code-review", "deploy"],
      instructions: [{ path: "AGENT.md", scope: "AGENT.md" }],
      stats: {
        ...emptyStats,
        contextWindow: 1_000_000,
        inputTokens: 128_000,
        outputTokens: 24_000,
        totalTokens: 152_000,
        cacheReadTokens: 96_000,
        turns: 3,
        byRole: { ...emptyStats.byRole, main: 152_000, fast: 1_200 },
      },
    },
  })

  // Seed a short, realistic run so the rail / activity tree aren't empty.
  store.pushBlock({ kind: "user", text: "add a dark-theme toggle to the settings menu" })
  store.pushBlock({
    kind: "assistant",
    text: "I'll wire a `theme` setting and a `:theme` command. Reading the current settings first.",
  })
  store.pushBlock({
    kind: "tool",
    id: "tool-read-1",
    toolName: "read_file(settingsView.ts)",
    state: "ok",
    detail: "128 lines",
  })
  store.pushBlock({
    kind: "tool",
    id: "tool-edit-1",
    toolName: "edit_file(settingsView.ts)",
    state: "ok",
    detail: "+18 -2",
  })
  store.pushBlock({ kind: "assistant", text: "Added the toggle and the `:theme` picker. Done." })

  return {
    store,
    variant: "master",
    run: opts.run,
    submit: () => {},
    interrupt: () => {},
    clearQueue: () => {},
    exit: opts.onExit,
    copySelection: () => false,
    resolveApproval: () => {},
    roles: [],
    tools: [],
    spawnAgent: () => {},
    stopAgent: () => {},
    listFleet: () => [],
    liveAgents: () => [],
    importAgents: () => {},
    importTools: () => {},
    getDirective: () => undefined,
    setDirective: () => {},
  }
}
