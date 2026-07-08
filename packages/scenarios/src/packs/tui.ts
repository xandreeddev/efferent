import { Effect } from "effect"
import { makeScriptedImplementor } from "@xandreed/foundry"
import { runForgeSessionWith } from "@xandreed/smith"
import {
  bootTestTui,
  proposingRefineAgent,
} from "@xandreed/smith/tui-testing"
import type { TestTui } from "@xandreed/smith/tui-testing"
import type { Check, Pack } from "../framework/model.js"
import { scenario } from "../framework/run.js"
import { fileContains, fileExists } from "../framework/evidence.js"

/**
 * The TUI pack: the workspace session's full loop driven at the FRAME level —
 * the real App over OpenTUI's headless test renderer, input as raw bytes
 * through the production StdinParser, checks on the rendered text. This is
 * the eval layer literally watching the TUI's pixels; it exists because
 * three TUI failures shipped while the packs only watched the harness.
 */

interface TuiWorld {
  readonly tui: TestTui
  readonly dir: string
  readonly events: () => ReadonlyArray<{ readonly type: string }>
}

const bootTuiWorld = Effect.acquireRelease(
  Effect.promise(async () => {
    const tui = await bootTestTui({
      seams: {
        refineAgent: proposingRefineAgent({
          goal: "Create out.txt containing done.",
          acceptance: ["out.txt exists"],
          checks: [{ name: "out-exists", command: "test -f out.txt" }],
        }),
        forgeRunner: (run, publish, doc) =>
          runForgeSessionWith(
            run,
            publish,
            makeScriptedImplementor([[{ path: "out.txt", content: "done\n" }]]),
            doc,
          ),
      },
    })
    return { tui, dir: tui.cwd, events: () => [] } satisfies TuiWorld
  }),
  (world) => Effect.promise(() => world.tui.dispose()),
)

/** Drive keys, then wait until the frame satisfies the predicate. */
const drive = (
  world: TuiWorld,
  input: string,
  until: (frame: string) => boolean,
): Effect.Effect<void> =>
  Effect.promise(async () => {
    if (input.length > 0) {
      await world.tui.setup.mockInput.typeText(input)
      world.tui.setup.mockInput.pressEnter()
    }
    const attempt = async (left: number): Promise<void> => {
      const frame = await world.tui.frame()
      if (until(frame) || left <= 0) return
      await new Promise((resolve) => setTimeout(resolve, 25))
      world.tui.tick()
      return attempt(left - 1)
    }
    return attempt(200)
  })

const frameShows = (name: string, needle: string): Check<TuiWorld> => ({
  name: `frame-shows:${name}`,
  severity: "hard",
  run: (world) =>
    Effect.promise(async () => {
      const frame = await world.tui.frame()
      return frame.includes(needle)
        ? { pass: true }
        : { pass: false, detail: `frame does not show "${needle}"` }
    }),
})

export const tuiPack: Pack = {
  name: "tui",
  threshold: 0.95,
  scenarios: [
    scenario<TuiWorld>({
      name: "workspace session: idea → draft → :lock → :forge → dashboard (frame twin)",
      modes: ["scripted"],
      boot: bootTuiWorld,
      steps: [
        {
          name: "boot shows the dashboard",
          act: (w) => drive(w, "", (f) => f.includes("describe what to build")),
          checks: [
            frameShows("dashboard", "forge runs"),
            frameShows("composer", "describe what to build"),
          ],
        },
        {
          name: "an idea becomes a draft in the SpecPanel",
          act: (w) => drive(w, "make an out file", (f) => f.includes("Create out.txt")),
          checks: [frameShows("draft", "Create out.txt containing done.")],
        },
        {
          name: ":lock flips the badge",
          act: (w) => drive(w, ":lock", (f) => f.includes("locked")),
          checks: [frameShows("locked", "locked")],
        },
        {
          name: ":forge runs the gates to acceptance on the floor",
          act: (w) => drive(w, ":forge", (f) => f.includes("accepted (attempt 1)")),
          checks: [
            frameShows("accept-gate", "accept-out-exists"),
            frameShows("outcome", "accepted (attempt 1)"),
            fileExists("out.txt"),
            fileContains("out.txt", "done"),
          ],
        },
        {
          name: ":new returns to a dashboard that grew",
          act: (w) => drive(w, ":new", (f) => f.includes("✓ accepted (attempt 1)")),
          checks: [
            frameShows("run-line", "✓ accepted (attempt 1)"),
            frameShows("spec-line", "create-out-txt-containing-done"),
          ],
        },
      ],
    }),
  ],
}
