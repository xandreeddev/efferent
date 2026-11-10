import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Result } from "effect"

const repository = join(import.meta.dir, "..", "..", "..", "..")

/** Whether `pid` is gone within `ms` (an orphan may stay a zombie until its new parent reaps it). */
const goneWithin = async (pid: number, ms: number): Promise<boolean> => {
  const alive = () => Result.isSuccess(Result.try(() => process.kill(pid, 0)))
  const deadline = Date.now() + ms
  while (alive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  return !alive()
}

const readPids = async (path: string, ms: number): Promise<ReadonlyArray<number>> => {
  const deadline = Date.now() + ms
  for (;;) {
    const text = await readFile(path, "utf8").then((value) => value, () => "")
    const pids = text.split(/[^0-9]+/).filter((part) => part.length > 0).map(Number)
    if (pids.length === 2 || Date.now() > deadline) return pids
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** An implementor that starts a tool process and records both pids; `ignoring` makes both ignore SIGTERM. */
const implementorOf = (ignoring: boolean) => [
  'const { spawn } = require("node:child_process")',
  'const { writeFileSync } = require("node:fs")',
  ignoring
    ? 'const tool = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })'
    : 'const tool = spawn("sleep", ["30"], { stdio: "ignore" })',
  ...(ignoring ? ['process.on("SIGTERM", () => {})'] : []),
  'writeFileSync("pids", JSON.stringify([process.pid, tool.pid]))',
  "setInterval(() => {}, 1000)",
].join("\n")

/**
 * Foundry's `runMain` running an implementor in a process of its own; `signal` sends it signals once the implementor and
 * its tool run. Then: how long foundry took to exit after the last signal, and whether both pids are gone soon after.
 */
const signalled = async (implementor: string, signal: (foundry: ReturnType<typeof spawn>) => Promise<void>) => {
  await mkdir(join(repository, ".artifacts"), { recursive: true })
  const directory = await mkdtemp(join(repository, ".artifacts", "foundry-signal-"))
  return (async () => {
    const source = join(import.meta.dir, "..")
    const script = [
      'import { Option } from "effect"',
      `import { runMain } from ${JSON.stringify(join(source, "cli", "runMain.ts"))}`,
      `import { implementCommand } from ${JSON.stringify(join(source, "adapters", "claudeImplementor.ts"))}`,
      `import { AttemptNumber, WorkspacePath } from ${JSON.stringify(join(source, "domain", "Brands.ts"))}`,
      `import { ForgeLimits, Spec } from ${JSON.stringify(join(source, "domain", "Spec.ts"))}`,
      'const spec = new Spec({ goal: "wait", acceptance: ["none"], limits: new ForgeLimits({ maxAttempts: 1, budgetMillis: 1000 }) })',
      `const input = { spec, feedback: Option.none(), attempt: AttemptNumber.make(1), workspaceDir: WorkspacePath.make(${JSON.stringify(directory)}) }`,
      `await runMain(implementCommand(input, [process.execPath, "-e", ${JSON.stringify(implementor)}]))`,
    ].join("\n")
    await writeFile(join(directory, "main.ts"), script)
    const foundry = spawn(process.execPath, [join(directory, "main.ts")], { cwd: directory, stdio: "ignore" })
    const exited = new Promise<number | null>((resolve) => foundry.once("exit", (code) => resolve(code)))
    const pids = await readPids(join(directory, "pids"), 10_000)
    expect(pids).toHaveLength(2)
    await signal(foundry)
    const sent = Date.now()
    const code = await exited
    const tookMs = Date.now() - sent
    const stopped = [await goneWithin(pids[0]!, 6000), await goneWithin(pids[1]!, 6000)]
    pids.forEach((pid) => Result.try(() => process.kill(pid, "SIGKILL")))
    return { code, tookMs, stopped }
  })().finally(() => rm(directory, { recursive: true, force: true }))
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("a signal to foundry interrupts its program, so an implementor it started is stopped with its tool processes", async () => {
  const { code, stopped } = await signalled(implementorOf(false), async (foundry) => { foundry.kill("SIGINT") })
  expect([code, stopped]).toEqual([130, [true, true]])
}, 30_000)

test("a hangup (the terminal closed) stops an implementor foundry started with its tool processes, though they left the terminal's session", async () => {
  const { code, stopped } = await signalled(implementorOf(false), async (foundry) => { foundry.kill("SIGHUP") })
  expect([code, stopped]).toEqual([129, [true, true]])
}, 30_000)

test.each([["SIGINT", "SIGINT", 130], ["SIGINT", "SIGTERM", 143]] as const)("a second signal (%s, then %s) ends foundry at once and kills an implementor and tool that ignore SIGTERM", async (first, second, exitCode) => {
  const { code, tookMs, stopped } = await signalled(implementorOf(true), async (foundry) => {
    foundry.kill(first)
    // Within the implementor's grace period: the first signal's cleanup is waiting for it to stop.
    await pause(400)
    foundry.kill(second)
  })
  expect([code, tookMs < 1500, stopped]).toEqual([exitCode, true, [true, true]])
}, 30_000)
