import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { JOURNAL_FORMAT, Journal } from "@xandreed/core/kernel"

const root = join(import.meta.dir, "..")
const released = "authentic release fixture must stay untouched\n"
const development = "previous development fixture\n"
const isolated = async <A>(body: (directory: string) => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "efferent-journal-cli-"))
  return Promise.resolve().then(async () => {
    await mkdir(join(directory, "scripts"))
    await mkdir(join(directory, "packages/core"), { recursive: true })
    await mkdir(join(directory, "packages/sdk/fixtures"), { recursive: true })
    await writeFile(join(directory, "packages/core/package.json"), '{"version":"0.14.0"}\n')
    await writeFile(join(directory, "tsconfig.json"), JSON.stringify({ extends: join(root, "tsconfig.base.json") }))
    await writeFile(join(directory, "packages/sdk/fixtures/journal-0.14.0.json"), released)
    await writeFile(join(directory, "packages/sdk/fixtures/journal-unreleased.json"), development)
    await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir")
    await copyFile(join(root, "scripts/record-journal-fixture.ts"), join(directory, "scripts/record-journal-fixture.ts"))
    await copyFile(join(root, "scripts/journal-fixture-coverage.ts"), join(directory, "scripts/journal-fixture-coverage.ts"))
    return body(directory)
  }).finally(() => rm(directory, { recursive: true, force: true }))
}
const invoke = async (directory: string, args: ReadonlyArray<string>) => {
  const child = Bun.spawn([process.execPath, "scripts/record-journal-fixture.ts", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill(), 20_000)
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    .then(([code, stdout, stderr]) => ({ code, stdout, stderr })).finally(() => clearTimeout(timeout))
}

test.each([
  { args: [], message: "journal-0.14.0.json exists" },
  { args: ["--force"], message: "--force requires --unreleased" },
  { args: ["--unreleased"], message: "journal-unreleased.json exists" },
])("journal recorder guard %j performs no writes", async ({ args, message }) => isolated(async directory => {
  const report = await invoke(directory, args)
  expect(report.code).toBe(1)
  expect(report.stderr).toContain(message)
  expect(await readFile(join(directory, "packages/sdk/fixtures/journal-0.14.0.json"), "utf8") === released).toBe(true)
  expect(await readFile(join(directory, "packages/sdk/fixtures/journal-unreleased.json"), "utf8")).toBe(development)
}), 30_000)

test("explicit development recording writes only the isolated unreleased fixture, the same bytes each time", async () => isolated(async directory => {
  const report = await invoke(directory, ["--unreleased", "--force"])
  expect(report.code).toBe(0)
  expect(await readFile(join(directory, "packages/sdk/fixtures/journal-0.14.0.json"), "utf8") === released).toBe(true)
  const target = join(directory, "packages/sdk/fixtures/journal-unreleased.json")
  const first = await readFile(target, "utf8")
  const fixture = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
    version: Schema.String, journalFormat: Schema.Int, sessions: Schema.Array(Journal),
  })))(first))
  expect(fixture.version).toBe("unreleased")
  expect(fixture.journalFormat).toBe(JOURNAL_FORMAT)
  const names = new Set<string>(fixture.sessions.flatMap((session) => session.events.map((event) => event.name)))
  expect(["conversation.tool.result", "plugin.approval.decided", "plugin.facts.learned", "plugin.summary.summarized", "plugin.knowledge.memory", "plugin.knowledge.ended"].filter((name) => !names.has(name))).toEqual([])
  expect(report.stdout).toContain("journal-unreleased.json")
  // A second recording writes the same bytes: nothing of the time, the machine or the folder it ran in.
  expect((await invoke(directory, ["--unreleased", "--force"])).code).toBe(0)
  expect(await readFile(target, "utf8")).toBe(first)
}), 30_000)

test("the normal release command still creates a new fixture once", async () => isolated(async directory => {
  const target = join(directory, "packages/sdk/fixtures/journal-0.14.0.json")
  await rm(target)
  expect((await invoke(directory, [])).code).toBe(0)
  expect((await Bun.file(target).json()).version).toBe("0.14.0")
  expect((await invoke(directory, [])).code).toBe(1)
  expect(await readFile(join(directory, "packages/sdk/fixtures/journal-unreleased.json"), "utf8")).toBe(development)
}), 30_000)

test("concurrent normal recordings publish one complete release fixture exclusively", async () => isolated(async directory => {
  const target = join(directory, "packages/sdk/fixtures/journal-0.14.0.json")
  await rm(target)
  const reports = await Promise.all([invoke(directory, []), invoke(directory, [])])
  expect(reports.map(report => report.code).toSorted((a, b) => a - b)).toEqual([0, 1])
  const fixture = await Bun.file(target).json()
  expect(fixture.version).toBe("0.14.0")
  expect(fixture.journalFormat).toBe(JOURNAL_FORMAT)
  expect(fixture.sessions.flatMap((session: { events: { name: string }[] }) => session.events).some((event: { name: string }) => event.name === "plugin.summary.summarized")).toBe(true)
  expect(await readFile(join(directory, "packages/sdk/fixtures/journal-unreleased.json"), "utf8")).toBe(development)
}), 30_000)

test("a recording that misses a kind of record the fixture must hold is refused, naming it, and writes nothing", async () => isolated(async directory => {
  // The isolated copy asks for one kind more than the host records.
  const coverage = join(directory, "scripts/journal-fixture-coverage.ts")
  const source = await readFile(coverage, "utf8")
  const asked = source.replace('  named("plugin.knowledge.curated"),\n]', '  named("plugin.knowledge.curated"),\n  named("plugin.never.recorded"),\n]')
  expect(asked).not.toBe(source)
  await writeFile(coverage, asked)
  const target = join(directory, "packages/sdk/fixtures/journal-0.14.0.json")
  await rm(target)
  const report = await invoke(directory, [])
  expect(report.code).toBe(1)
  expect(report.stderr).toContain("The recording holds no plugin.never.recorded; nothing was written.")
  expect(await Bun.file(target).exists()).toBe(false)
  expect(await readFile(join(directory, "packages/sdk/fixtures/journal-unreleased.json"), "utf8")).toBe(development)
}), 30_000)
