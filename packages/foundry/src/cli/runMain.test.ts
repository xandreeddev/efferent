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

test("a signal to foundry interrupts its program, so an implementor it started is stopped with its tool processes", async () => {
  // Under the repository, so the script resolves `effect` as foundry's own modules do.
  await mkdir(join(repository, ".artifacts"), { recursive: true })
  const directory = await mkdtemp(join(repository, ".artifacts", "foundry-signal-"))
  await (async () => {
    const source = join(import.meta.dir, "..")
    const implementor = [
      'const { spawn } = require("node:child_process")',
      'const { writeFileSync } = require("node:fs")',
      'const tool = spawn("sleep", ["30"], { stdio: "ignore" })',
      'writeFileSync("pids", JSON.stringify([process.pid, tool.pid]))',
      "setInterval(() => {}, 1000)",
    ].join("\n")
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
    foundry.kill("SIGINT")
    await exited
    const stopped = [await goneWithin(pids[0]!, 6000), await goneWithin(pids[1]!, 6000)]
    // Whatever the outcome, leave nothing running.
    pids.forEach((pid) => Result.try(() => process.kill(pid, "SIGKILL")))
    expect(stopped).toEqual([true, true])
  })().finally(() => rm(directory, { recursive: true, force: true }))
}, 30_000)
