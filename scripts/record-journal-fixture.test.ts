import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { replayModelRequest, RunId, SessionHeader, SessionLogEvent, STORED_FORMAT } from "@xandreed/core"

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
    return body(directory)
  }).finally(() => rm(directory, { recursive: true, force: true }))
}
const invoke = async (directory: string, args: ReadonlyArray<string>) => {
  const child = Bun.spawn([process.execPath, "scripts/record-journal-fixture.ts", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const timeout = setTimeout(() => child.kill(), 10_000)
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
}), 15_000)

test("explicit development recording writes only the isolated unreleased fixture", async () => isolated(async directory => {
  const report = await invoke(directory, ["--unreleased", "--force"])
  expect(report.code).toBe(0)
  expect(await readFile(join(directory, "packages/sdk/fixtures/journal-0.14.0.json"), "utf8") === released).toBe(true)
  const fixture = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.Struct({
    version: Schema.String, storedFormat: Schema.Int, reserved: Schema.Array(Schema.String),
    sessions: Schema.Array(Schema.Struct({ header: SessionHeader, events: Schema.Array(SessionLogEvent) })),
  }))(await Bun.file(join(directory, "packages/sdk/fixtures/journal-unreleased.json")).json()))
  expect(fixture.version).toBe("unreleased")
  expect(fixture.storedFormat).toBe(STORED_FORMAT)
  expect(fixture.reserved).toContain("model.called")
  const events = fixture.sessions[0]!.events
  const requests = events.filter(event => event.kind === "request.prepared")
  expect(requests.length).toBeGreaterThan(0)
  const replayed = await Effect.runPromise(Effect.forEach(requests, event => replayModelRequest(events, RunId.make(String(event.data.runId)), Number(event.data.step)), { concurrency: 1 }))
  expect(replayed.every(request => request.prompt.content.length > 1)).toBe(true)
  expect(report.stdout).toContain("journal-unreleased.json")
}), 15_000)

test("the normal release command still creates a new fixture once", async () => isolated(async directory => {
  const target = join(directory, "packages/sdk/fixtures/journal-0.14.0.json")
  await rm(target)
  expect((await invoke(directory, [])).code).toBe(0)
  expect((await Bun.file(target).json()).version).toBe("0.14.0")
  expect((await invoke(directory, [])).code).toBe(1)
  expect(await readFile(join(directory, "packages/sdk/fixtures/journal-unreleased.json"), "utf8")).toBe(development)
}), 15_000)

test("concurrent normal recordings publish one complete release fixture exclusively", async () => isolated(async directory => {
  const target = join(directory, "packages/sdk/fixtures/journal-0.14.0.json")
  await rm(target)
  const reports = await Promise.all([invoke(directory, []), invoke(directory, [])])
  expect(reports.map(report => report.code).toSorted((a, b) => a - b)).toEqual([0, 1])
  const fixture = await Bun.file(target).json()
  expect(fixture.version).toBe("0.14.0")
  expect(fixture.storedFormat).toBe(STORED_FORMAT)
  expect(fixture.sessions.flatMap((session: { events: { kind: string }[] }) => session.events).some((event: { kind: string }) => event.kind === "request.prepared")).toBe(true)
  expect(await readFile(join(directory, "packages/sdk/fixtures/journal-unreleased.json"), "utf8")).toBe(development)
}), 15_000)
