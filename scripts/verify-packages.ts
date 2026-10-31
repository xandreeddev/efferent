import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { Result, Schema } from "effect"
import { apiBuildOf, apiDifferences, apiSnapshot, committedApi } from "./api-snapshot.js"
import { isTestCode, verifyRefusals } from "./build-check.js"
import { declarationImportProblems } from "./declaration-imports.js"
import type { DeclaringManifest } from "./declaration-imports.js"
import { installedCopies, PEERS } from "./distribution-manifest.js"
import { importsFor, importsOf, regionsOf } from "./guide-snippets.js"
import { BuildStamp } from "./publish-plan.js"
const root = join(import.meta.dir, "..")
/** The consumer installs the Effect the packages were built against, and the repo's TypeScript. */
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { readonly dependencies: { readonly effect: string }, readonly devDependencies: { readonly typescript: string } }
const packages = join(root, ".artifacts/packages")
/**
 * Only the build of HEAD is checked, so a build left over from other sources cannot pass:
 * `build.json` must record HEAD and a clean tree, and the packages must hold no test code.
 * `--allow-dirty` accepts a build of uncommitted changes, to check them before committing.
 */
const args = process.argv.slice(2)
const unknownArgs = args.filter((arg) => arg !== "--allow-dirty")
if (unknownArgs.length > 0) {
  console.error(`Unknown argument: ${unknownArgs.join(" ")}\nUsage: bun run verify:packages [--allow-dirty]`)
  process.exit(2)
}
const stampFile = Bun.file(join(packages, "build.json"))
const stamp = Schema.decodeUnknownResult(Schema.fromJsonString(BuildStamp))(await stampFile.exists() ? await stampFile.text() : "")
if (Result.isFailure(stamp)) {
  console.error(`Refusing to verify: .artifacts/packages/build.json is missing or not valid; run bun run build:packages first`)
  process.exit(1)
}
const headRun = Bun.which("git") === null ? undefined : Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "pipe" })
const refusals = verifyRefusals({
  stamp: stamp.success,
  head: { success: headRun?.success ?? false, stdout: headRun?.stdout.toString().trim() ?? "", stderr: headRun?.stderr.toString().trim() ?? "" },
  testCode: Array.from(new Bun.Glob("*/dist/**/*").scanSync({ cwd: packages, onlyFiles: true })).filter((file) => isTestCode(file.split("/").slice(2).join("/"))).sort(),
  allowDirty: args.includes("--allow-dirty"),
})
if (refusals.length > 0) {
  console.error(`Refusing to verify:\n${refusals.map((reason) => `  - ${reason}`).join("\n")}`)
  process.exit(1)
}
/** What each published entry exports, read from the build's declarations, is what api/ records (scripts/api-snapshot.ts). */
const api = apiSnapshot(apiBuildOf(root, stamp.success.packages.map((entry) => entry.dir)))
const apiProblems = [...api.problems, ...(api.problems.length > 0 ? [] : apiDifferences(committedApi(join(root, "api")), api.files))]
if (apiProblems.length > 0) {
  console.error(`The public API of the build is not the one api/ records:\n${apiProblems.map((problem) => `  - ${problem}`).join("\n")}\nRun bun run api:update and commit api/ with the change.`)
  process.exit(1)
}
console.log(`The public API of the build matches api/ (${api.files.size} entries)`)
/** A built package's declarations name only itself, what its manifest declares and the runtime's modules (scripts/declaration-imports.ts). */
const declarationProblems = (await Promise.all(stamp.success.packages.map(async ({ dir }) => {
  const manifest = JSON.parse(await readFile(join(packages, dir, "package.json"), "utf8")) as DeclaringManifest
  const files = Array.from(new Bun.Glob("dist/**/*.d.ts").scanSync({ cwd: join(packages, dir) })).sort()
  return declarationImportProblems(manifest, await Promise.all(files.map(async (file) => ({ path: `${dir}/${file}`, text: await readFile(join(packages, dir, file), "utf8") }))))
}))).flat()
if (declarationProblems.length > 0) {
  console.error(`The built declarations import packages their manifests do not declare:\n${declarationProblems.map((problem) => `  - ${problem}`).join("\n")}\nName the type through the package's own module (an import in the source file that emits it).`)
  process.exit(1)
}
console.log(`The built declarations of ${stamp.success.packages.length} packages import only what their manifests declare`)
const tarballs = join(root, ".artifacts/tarballs")
await mkdir(tarballs, { recursive: true })
const manifests = Array.from(new Bun.Glob("*/package.json").scanSync({ cwd: packages }))
const artifacts = await Promise.all(manifests.map(async (file) => {
  const path = join(packages, file)
  const manifest = JSON.parse(await readFile(path, "utf8"))
  const child = Bun.spawn(["npm", "pack", "--ignore-scripts", "--silent", "--pack-destination", tarballs], { cwd: join(path, ".."), stdout: "pipe", stderr: "inherit", env: { ...process.env, npm_config_cache: join(root, ".artifacts/npm-cache") } })
  const filename = (await new Response(child.stdout).text()).trim()
  if (await child.exited !== 0) process.exit(1)
  const tarballPath = join(tarballs, filename)
  const shasum = createHash("sha1").update(await readFile(tarballPath)).digest("hex")
  return { manifest, file: tarballPath, shasum }
}))
const consumer = await mkdtemp(join(tmpdir(), "efferent-consumer-"))
const registry: Bun.Server<undefined> = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
  const path = decodeURIComponent(new URL(request.url).pathname).slice(1)
  const artifact = artifacts.find((entry) => entry.manifest.name === path || `${entry.manifest.name}/artifact.tgz` === path)
  if (artifact === undefined) return new Response("Unknown local package", { status: 404 })
  if (path.endsWith("artifact.tgz")) return new Response(Bun.file(artifact.file))
  const { manifest } = artifact
  return Response.json({ name: manifest.name, "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: { ...manifest, dist: { shasum: artifact.shasum, tarball: `http://127.0.0.1:${registry.port}/${manifest.name}/artifact.tgz` } } } })
} })
await writeFile(join(consumer, "bunfig.toml"), `[install.scopes]\n"@xandreed" = { url = "http://127.0.0.1:${registry.port}" }\n`)
await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { ...Object.fromEntries(artifacts.map(({manifest}) => [manifest.name,manifest.version])), effect: rootManifest.dependencies.effect, typescript: rootManifest.devDependencies.typescript, "@types/bun": "1.3.14" } }))
console.log(`Installing from temporary local registry into ${consumer}`)
const install = Bun.spawn(["bun", "install", "--ignore-scripts", "--no-cache", "--cache-dir", join(consumer, ".install-cache")], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await install.exited !== 0) process.exit(1)
/** The consumer holds one copy of each package the framework shares with its host: two would split their classes and services. */
const copies = Array.from(installedCopies(join(consumer, "node_modules"), PEERS)).filter(([, found]) => found.length !== 1)
if (copies.length > 0) {
  console.error(`The consumer did not install one copy of each shared package:\n${copies.map(([name, found]) => `  - ${name}: ${found.length === 0 ? "none" : found.map((dir) => relative(consumer, dir)).join(", ")}`).join("\n")}`)
  process.exit(1)
}
console.log(`The consumer installed one copy each of ${PEERS.join(" and ")}`)
/**
 * The FileSystem and Bash kits over the packed `@xandreed/plugin-workspace`
 * adapters, each check in a fresh directory under the system's temporary
 * directory, then its skills directory plugin over a SKILL.md tree there:
 * run by `verify.ts` on Bun and by `node-imports.mjs` on Node, which import
 * the names it uses and define `linkTo` (`fs.symlink`).
 */
const localKits = `
const temporary = Effect.acquireRelease(Effect.promise(() => mkdtemp(join(tmpdir(), "efferent-kit-"))), (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })))
const localFileSystem = await Effect.runPromise(Effect.service(FileSystem).pipe(Effect.provide(FileSystemLive)))
const localKitChecks = [
 ...fileSystemConformance({ open: temporary.pipe(Effect.map((root) => ({ fs: localFileSystem, root, symlink: linkTo }))) }),
 ...bashConformance({ open: (planted) => Effect.all({ root: temporary, bash: Effect.service(Bash).pipe(Effect.provide(BashLive({ parentEnv: { ...process.env, ...planted } }))) }), holdsBack: typeof Bun === "undefined" }),
]
const localKitFailures = (await Effect.runPromise(Effect.forEach(localKitChecks, (check) => Effect.result(check.run).pipe(
 Effect.map((result) => result._tag === "Failure" ? [check.name + ": " + result.failure.message] : []))))).flat()
if (localKitFailures.length > 0) { console.error(localKitFailures.join("\\n")); process.exit(1) }
console.log("The FileSystem and Bash kits passed over the packed local adapters on " + (typeof Bun === "undefined" ? "Node" : "Bun") + " (" + localKitChecks.length + " checks)")
const imageCli = await Effect.runPromise(Effect.scoped(Effect.result(Layer.build(ImageResizerCliLive().pipe(Layer.provide(Layer.merge(FileSystemLive, BashLive())))))))
if (imageCli._tag === "Failure" && !Option.contains(harnessCodeOf(imageCli.failure), "images.unavailable")) { console.error("The image CLI could not activate", imageCli.failure); process.exit(1) }
if (imageCli._tag === "Success") {
 const checks = imageResizerConformance({ open: () => Layer.build(ImageResizerCliLive().pipe(Layer.provide(Layer.merge(FileSystemLive, BashLive())))).pipe(Effect.map((context) => Context.get(context, ImageResizer))) })
 await Effect.runPromise(Effect.forEach(checks, (check) => check.run, { concurrency: 1 }))
 console.log("The image resize kit passed over the packed CLI on " + (typeof Bun === "undefined" ? "Node" : "Bun"))
} else console.log("The optional image CLI kit needs ImageMagick, libvips or sips")
const skillsWorkspace = await mkdtemp(join(tmpdir(), "efferent-skills-"))
await mkdir(join(skillsWorkspace, ".agents/skills/greet/references"), { recursive: true })
await writeFile(join(skillsWorkspace, ".agents/skills/greet/SKILL.md"), "---\\nname: greet\\ndescription: Greet people.\\n---\\nSay hello.\\n")
await writeFile(join(skillsWorkspace, ".agents/skills/greet/references/tone.md"), "# Tone\\n\\nWarm.\\n")
const directorySkills = await Effect.runPromise(Effect.scoped(Layer.build(SkillsDirectoryPluginLive().pipe(
 Layer.provide(Layer.merge(FileSystemLive, Layer.succeed(SessionEnvironment, { workspace: skillsWorkspace })))))).pipe(
 Effect.map((context) => Context.get(context, Capabilities).flatMap((capability) => capability.skills))))
await rm(skillsWorkspace, { recursive: true, force: true })
if (directorySkills.length !== 1 || directorySkills[0]?.id !== "greet" || directorySkills[0]?.references[0]?.id !== "references/tone.md") { console.error("The skills directory read " + JSON.stringify(directorySkills)); process.exit(1) }
console.log("The skills directory plugin read a SKILL.md tree over the packed local file system on " + (typeof Bun === "undefined" ? "Node" : "Bun"))
`
/**
 * The workspace tools over the packed packages: one agent turn with
 * `localSystemPlugin` and `workspaceToolsPlugin` in a fresh directory, a
 * scripted model reading a file, loading the edit and shell skills, editing
 * it, running a command with stdin and a host variable, and reading an
 * image, which the next request sends as an image. Run by
 * `verify.ts` on Bun and by `node-imports.mjs` on Node, which import the
 * names it uses. The script is JSON, so the same text is TypeScript and
 * JavaScript.
 */
const workspaceJourney = `
const workspaceRoot = await realpath(await mkdtemp(join(tmpdir(), "efferent-workspace-")))
const workspaceReferences = await realpath(await mkdtemp(join(tmpdir(), "efferent-references-")))
const workspaceReference = join(workspaceReferences, "reference.txt")
await writeFile(workspaceReference, "reference facts")
await writeFile(join(workspaceRoot, "notes.md"), "- buy milk\\n")
const workspacePixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const workspaceOriginal = new Uint8Array(Buffer.from(workspacePixel, "base64"))
new DataView(workspaceOriginal.buffer).setUint32(16, 9000)
new DataView(workspaceOriginal.buffer).setUint32(20, 6000)
await writeFile(join(workspaceRoot, "chart.png"), workspaceOriginal)
const workspaceUsage = { inputTokens: { total: 3 }, outputTokens: { total: 1 } }
const workspaceCalls = [
 { name: "read", params: { path: "notes.md" } },
 { name: "load_skill", params: { skills: ["workspace.edit", "workspace.shell"] } },
 { name: "read", params: { path: workspaceReference } },
 { name: "write", params: { path: workspaceReference, content: "replacement" } },
 { name: "edit", params: { path: "notes.md", edits: [{ oldText: "milk", newText: "oat milk" }] } },
 { name: "bash", params: { command: "cat notes.md -; echo \\"$WORKSPACE_PROBE\\"; printf 'parent=%s:%s\\\\n' \\"$HOME\\" \\"$WORKSPACE_PARENT\\"", stdin: "from stdin\\n" } },
 { name: "read", params: { path: "chart.png" } },
]
const workspaceScript = JSON.parse(JSON.stringify([
 ...workspaceCalls.map((step, at) => [{ type: "tool-call", id: "w" + at, name: step.name, params: step.params }, { type: "finish", reason: "tool-calls", usage: workspaceUsage }]),
 [{ type: "text", text: "done" }, { type: "finish", reason: "stop", usage: workspaceUsage }],
]))
const workspacePrompts = JSON.parse("[]")
const workspaceRecorded = JSON.parse("[]")
const workspaceTurn = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
 const sessions = Context.get(yield* Layer.build(SessionsPluginLive({ ownership: { mode: "process" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
 const agent = yield* Agent.define({
  services: Context.make(ImageResizer, ImageResizer.of({ fit: () => Effect.succeed(Buffer.from(workspacePixel, "base64")) })),
  plugins: [memoryWindowPlugin, { plugin: toolDiscoveryPlugin, options: { grants: ["fs.write", "shell.exec"] } }, stepLoopPlugin,
   { plugin: localSystemPlugin, options: { parentEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: workspaceRoot, WORKSPACE_PARENT: "hidden" } } },
   { plugin: workspaceToolsPlugin, options: { roots: [{ path: workspaceReferences, access: "read" }], bashEnv: { WORKSPACE_PROBE: "probe" } } }],
  turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 9 }, workspace: workspaceRoot,
 })
 const model = yield* LanguageModel.make({
  generateText: (options) => Effect.sync(() => workspaceScript[workspacePrompts.push(JSON.stringify(options.prompt.content)) - 1]),
  streamText: () => Stream.die("not scripted"),
 })
 const view = yield* sessions.create({ owner: "consumer" })
 const result = yield* agent.turn({ turn: { session: { id: view.header.id, owner: "consumer" }, userMessage: new UserMessage({ text: "make it oat milk" }), runId: RunId.make("workspace-1") }, services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)) },
  (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({})), Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) }))))
 workspaceRecorded.push(...(yield* sessions.read({ id: view.header.id, owner: "consumer" })))
 return result
})))
const workspaceRg = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
 const rgCalls = JSON.parse("[]")
 const rgBash = Bash.of({
  exec: () => Effect.succeed({ stdout: "ripgrep 15", stderr: "", exitCode: Option.some(0), signal: Option.none(), termination: "exit", durationMs: 1 }),
  stream: (command, options) => {
   rgCalls.push({ command, options })
   return Stream.make(
    { _tag: "BashChunk", stream: "stdout", text: JSON.stringify({ type: "match", data: { path: { text: "notes.md" }, lines: { text: "needle" }, line_number: 1 } }) + "\\n" },
    { _tag: "BashExit", exitCode: Option.some(0), signal: Option.none(), termination: "exit", durationMs: 1 },
   )
  },
 })
 const fs = yield* makeMemoryFileSystem({ "/work/notes.md": "needle" })
 const capability = yield* workspaceTools({ ...workspaceToolsDefaults, tools: ["grep"], grepEngine: "ripgrep" }).pipe(Effect.provideService(Bash, rgBash))
 const services = Context.make(FileSystem, fs).pipe(Context.add(SessionEnvironment, { workspace: "/work" }), Context.add(Bash, rgBash))
 const value = yield* capability.tools[0].handler({ pattern: "needle" }).pipe(Effect.provide(services), Effect.flatMap(Schema.decodeUnknownEffect(GrepResult)))
 return value.matches === 1 && value.files === 1 && value.timedOut === false && rgCalls.length === 1 && rgCalls[0].options.stdin === "needle" && !rgCalls[0].command.includes("needle")
})))
if (!workspaceRg) { console.error("The packed ripgrep adapter failed"); process.exit(1) }
const workspaceNotes = await readFile(join(workspaceRoot, "notes.md"), "utf8")
const workspaceReferenceAfter = await readFile(workspaceReference, "utf8")
const workspaceImageAfter = await readFile(join(workspaceRoot, "chart.png"))
await rm(workspaceRoot, { recursive: true, force: true })
await rm(workspaceReferences, { recursive: true, force: true })
const workspaceLast = String(workspacePrompts[workspacePrompts.length - 1] ?? "")
// The image read's tool result: its text the one-line view (no base64), the image a file part of its modelOutput.
const workspaceRead = [...JSON.parse(workspaceLast || "[]")].filter((message) => message.role === "tool").flatMap((message) => [...message.content])
 .find((part) => part.result === "[Image chart.png (image/png, 70 B), scaled down from 9000x6000 (image/png, 70 B).]")
const workspaceImageSent = workspaceRead !== undefined && [...(workspaceRead.modelOutput ?? [])].some((output) => output.type === "file" && output.mediaType === "image/png" && output.data === workspacePixel)
if (workspaceTurn.outcome !== "completed" || workspaceNotes !== "- buy oat milk\\n" || !workspaceLast.includes("- buy oat milk\\\\nfrom stdin\\\\nprobe\\\\nparent=" + workspaceRoot + ":\\\\n[Exit code 0.]")
 || !workspaceImageAfter.equals(Buffer.from(workspaceOriginal)) || JSON.stringify(workspaceRecorded).split(workspacePixel).length !== 2 || !JSON.stringify(workspaceRecorded).includes('"original":{"mediaType":"image/png","bytes":70,"width":9000,"height":6000}')
 || workspaceReferenceAfter !== "reference facts" || !workspaceLast.includes("reference facts") || !workspaceLast.includes("ReadOnly") || !workspaceImageSent) {
 console.error("The workspace tools journey failed: " + JSON.stringify({ outcome: workspaceTurn.outcome, notes: workspaceNotes, last: workspaceLast.slice(-600) }))
 process.exit(1)
}
console.log("The workspace tools read, edited and ran a command (stdin, host base environment), enforced an extra read root and fitted an image in an Agent.turn on " + (typeof Bun === "undefined" ? "Node" : "Bun"))
`
await writeFile(join(consumer, "verify.ts"), `
import { Context, Deferred, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { connect, createServer } from "node:net"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bash, Capabilities, FileSystem, harnessCodeOf, ImageResizer, makeMemoryFileSystem, TaskActivity, TaskExecutor, Tasks, TurnActivity } from "@xandreed/core"
import { bashConformance, fileSystemConformance, imageResizerConformance, sessionLogRecoveryConformance } from "@xandreed/core/conformance"
import type { TurnWriter } from "@xandreed/core"
import { modelsPlugin } from "@xandreed/plugin-models"
import { BashLive, FileSystemLive, ImageResizerCliLive, localSystemPlugin, SkillsDirectoryPluginLive, workspaceTools, workspaceToolsDefaults, GrepResult, workspaceToolsPlugin } from "@xandreed/plugin-workspace"
import { makeSessionLogSqlite, SessionLogSqliteLive } from "@xandreed/plugin-session-sqlite"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive, TasksPluginLive } from "@xandreed/plugin-tasks"
import { Agent, awaitIdle, RunId, Sessions, SessionEnvironment, SessionLogMemoryLive, TurnAdmissionOpen, UserMessage } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { EvalId, GraderAssessment, graderFromEvaluator, semanticEvaluator } from "@xandreed/evals"
import { SemanticJevLive } from "@xandreed/evals"
const usage = { inputTokens: { total: 3, cacheRead: 1, cacheWrite: 1 }, outputTokens: { total: 2, reasoning: 1 } }
const turned = await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
 const sessions = Context.get(yield* Layer.build(SessionsPluginLive({ ownership: { mode: "process" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
 const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 2 }, system: "Be brief." })
 const model = yield* LanguageModel.make({
  generateText: (options) => Effect.succeed([{ type: "text", text: JSON.stringify(options.prompt).includes("world") ? "hello world" : "unseen" }, { type: "finish", reason: "stop", usage }] as never),
  streamText: () => Stream.die("not scripted") as never,
 })
 const view = yield* sessions.create({ owner: "consumer" })
 const address = { id: view.header.id, owner: "consumer" }
 const admittedMeta = yield* Ref.make<unknown>(null)
 const outcome = yield* agent.turn({ turn: { session: address, userMessage: new UserMessage({ text: "world" }), runId: RunId.make("run-1"), meta: { request: "r-1" } }, services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)) },
  (turn) => Ref.set(admittedMeta, turn.admitted.meta).pipe(Effect.andThen(turn.run({})), Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) }))))
 const started = yield* sessions.read(address, { kinds: ["turn.started"] })
 const fork = yield* sessions.fork(address, { origin: "fork", inherit: true })
 yield* Effect.scoped(sessions.begin(address, { _tag: "User", userMessage: new UserMessage({ text: "world" }), runId: RunId.make("run-2"), key: "run-2", command: {} }).pipe(Effect.andThen(sessions.cancel(address, 2))))
 const resumed = yield* agent.turn({ turn: { session: address, userMessage: new UserMessage({ text: "Continue." }), runId: RunId.make("run-3"), resumes: 2 }, services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)) },
  (turn) => turn.reply("resumes " + String(turn.admitted.resumes)))
 const resumedStart = (yield* sessions.read(address, { kinds: ["turn.started"] })).at(-1)?.data
 return { outcome, forked: fork.header.parent, meta: JSON.stringify([yield* Ref.get(admittedMeta), started[0]?.data.meta]), resume: JSON.stringify([Option.getOrNull(resumed.reply), resumedStart?.key, resumedStart?.resumes]) }
})) )
if (turned.outcome.outcome !== "completed" || Option.getOrNull(turned.outcome.reply) !== "hello world" || Option.isNone(turned.forked)) process.exit(1)
if (turned.meta !== JSON.stringify([{ request: "r-1" }, { request: "r-1" }])) process.exit(1)
if (turned.resume !== JSON.stringify(["resumes 2", "resume:2", 2])) process.exit(1)
if (turned.outcome.usage.totalTokens !== 5 || turned.outcome.usage.cacheWriteTokens !== 1 || turned.outcome.usage.reasoningTokens !== 1) process.exit(1)
const rubric = semanticEvaluator({id:"external-quality",version:"1",questions:{supported:{type:"boolean",instructions:"Is the answer supported?"}},state:(input:{answer:string})=>input.answer})
const rubricGrader = graderFromEvaluator({definition:{id:EvalId.make("external-quality"),version:"1",kind:"model",metrics:["supported"],fingerprints:{}},input:Schema.Struct({answer:Schema.String}),evaluator:rubric},SemanticJevLive({evaluate:()=>Promise.resolve({answers:{supported:{type:"boolean",probability:0.9}}})}))
const graded = await Effect.runPromise(GraderAssessment.use((port)=>port.assess({projection:"answer",version:"1",input:{answer:"fixture"},references:[],omissions:[],bytes:0,fingerprint:"fixture"},{id:EvalId.make("consumer"),configuration:{},fingerprints:{}})).pipe(Effect.provide(rubricGrader.layer)))
if(graded.status!=="scored" || graded.metadata.backend!=="jev") process.exit(1)
console.log("Composable agent turn with host meta, session fork, resumed turn, eval composition and optional rubric adapter passed")
const answered = await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
 const done = yield* Deferred.make<string>()
 const react = (writer: TurnWriter) => Deferred.succeed(done, writer.admitted.userMessage.text).pipe(Effect.asVoid)
 const executor = Layer.succeed(TaskExecutor, TaskExecutor.of({ turn: (_writer, task) => Effect.succeed({ outcome: "completed" as const, reply: Option.some("found " + task.instructions) }), react }))
 const store = SessionsPluginLive({ ownership: { mode: "process" } }).pipe(Layer.provide(Layer.merge(SessionLogSqliteLive(".efferent/sessions.db"), TurnAdmissionOpen)))
 const context = yield* Layer.build(TasksPluginLive().pipe(Layer.provideMerge(Layer.mergeAll(store, InProcessTaskRunnerLive(), executor))))
 const sessions = Context.get(context, Sessions)
 const tasks = Context.get(context, Tasks)
 const view = yield* sessions.create({ owner: "consumer" })
 const address = { id: view.header.id, owner: "consumer" }
 const pending = yield* Effect.scoped(Effect.gen(function*(){
  const writer = yield* sessions.begin(address, { _tag: "User", userMessage: new UserMessage({ text: "hello" }), runId: RunId.make("run-1"), key: "k1", command: {} })
  yield* tasks.start(address, { instructions: "the answer", mode: "fork" })
  return (yield* writer.end({ reason: "completed", failure: Option.none() })).pending
 }))
 if (pending > 0) yield* sessions.drain(address, react)
 const text = yield* Deferred.await(done).pipe(Effect.timeout("5 seconds"))
 // The built context holds the sessions' TurnActivity and the runner's TaskActivity: wait until both settle.
 const probes = Option.isSome(Context.getOption(context, TurnActivity)) && Option.isSome(Context.getOption(context, TaskActivity))
 const idle = yield* awaitIdle({ timeout: "5 seconds" }).pipe(Effect.provide(context))
 return { text, probes, idle }
})))
if (!answered.text.includes("found the answer") || !answered.probes || answered.idle.busy || answered.idle.openTurns.length > 0 || answered.idle.beginningTurns > 0 || answered.idle.runningTasks > 0) process.exit(1)
console.log("Sessions over SQLite, a background task, the reaction to its result and awaitIdle after them passed")
const recovery = sessionLogRecoveryConformance({ open: makeSessionLogSqlite(".efferent/recovery.db"), callerClock: true })
const recoveryFailures = (await Effect.runPromise(Effect.forEach(recovery, (check) => Effect.result(check.run).pipe(
 Effect.map((result) => result._tag === "Failure" ? [check.name + ": " + result.failure.message] : []))))).flat()
if (recoveryFailures.length > 0) { console.error(recoveryFailures.join("\\n")); process.exit(1) }
console.log("The SessionLog recovery kit passed over the packed SQLite log (" + recovery.length + " checks)")
const fileSystem = fileSystemConformance({ open: makeMemoryFileSystem().pipe(Effect.tap((fs) => fs.mkdir("/work")), Effect.map((fs) => ({ fs, root: "/work", symlink: fs.symlink }))) })
const fileSystemFailures = (await Effect.runPromise(Effect.forEach(fileSystem, (check) => Effect.result(check.run).pipe(
 Effect.map((result) => result._tag === "Failure" ? [check.name + ": " + result.failure.message] : []))))).flat()
if (fileSystemFailures.length > 0) { console.error(fileSystemFailures.join("\\n")); process.exit(1) }
console.log("The FileSystem kit passed over the packed in-memory file system (" + fileSystem.length + " checks)")
const linkTo = (target: string, path: string) => Effect.tryPromise(() => symlink(target, path))
${localKits}
${workspaceJourney}
// The packed models plugin's proxy on Bun: fetch's own proxy option sends an http: endpoint's call to the proxy in
// absolute form. The proxy forwards *.invalid hosts (which no DNS resolves) to 127.0.0.1.
const chatEndpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
 const body = await request.json() as { readonly model?: unknown }
 return Response.json({ choices: [{ finish_reason: "stop", message: { content: "answered " + String(body.model) } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
} })
const chatPort = chatEndpoint.port
const proxied: Array<string> = []
const proxySockets: Array<Socket> = []
const recordingProxy = createServer((client) => {
 proxySockets.push(client)
 client.on("error", () => client.destroy())
 client.once("data", (chunk: Buffer) => {
  const head = chunk.toString("latin1")
  const target = head.split(" ")[1] ?? ""
  proxied.push(head.split("\\r\\n")[0] ?? "")
  const url = URL.canParse(target) ? new URL(target) : null
  if (url === null || !url.hostname.endsWith(".invalid")) return client.end("HTTP/1.1 403 Forbidden\\r\\ncontent-length: 0\\r\\nconnection: close\\r\\n\\r\\n")
  const upstream = connect(Number(url.port), "127.0.0.1", () => {
   upstream.write(head.replace(target, url.pathname + url.search), "latin1")
   upstream.pipe(client)
   client.pipe(upstream)
  })
  upstream.on("error", () => client.destroy())
  proxySockets.push(upstream)
 })
})
const proxyPort = await new Promise<number>((resolve) => recordingProxy.listen(0, "127.0.0.1", () => {
 const address = recordingProxy.address()
 resolve(typeof address === "object" && address !== null ? address.port : 0)
}))
const viaProxy = await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
 const services = yield* modelsPlugin.build({ ...modelsPlugin.defaults, storage: "memory", model: "stub:general", proxy: "http://127.0.0.1:" + proxyPort,
  endpoints: { stub: { url: "http://models.proxy-test.invalid:" + chatPort + "/v1" } } }, Context.make(SessionEnvironment, { workspace: process.cwd() }))
 return (yield* Context.getUnsafe(services, LanguageModel.LanguageModel).generateText({ prompt: "hi" })).text
})).pipe(Effect.timeout("20 seconds"), Effect.orElseSucceed(() => "no reply")))
proxySockets.forEach((socket) => socket.destroy())
recordingProxy.close()
chatEndpoint.stop(true)
const expectedProxied = ["POST http://models.proxy-test.invalid:" + chatPort + "/v1/chat/completions HTTP/1.1"]
if (viaProxy !== "answered general" || JSON.stringify(proxied) !== JSON.stringify(expectedProxied)) {
 console.error("The packed models plugin's proxy on Bun: " + viaProxy + ", the proxy saw " + JSON.stringify(proxied))
 process.exit(1)
}
console.log("The packed models plugin sent a model call through its proxy option on Bun (absolute form)")
`)
/**
 * The documentation's imports must exist in the packed packages: every
 * `@xandreed/*` import in a TypeScript or JavaScript code block of the
 * README, the guides and the website docs becomes one import in
 * `doc-imports.ts`, which the consumer typecheck compiles. A renamed or
 * removed export, or a subpath a package does not export, fails here.
 */
const websiteDocs = join(root, "packages/website/src/content/docs")
const documented = [
  ...["README.md", "docs/framework.md", "docs/events.md", "docs/composable-evaluations.md"].map((file) => join(root, file)).filter((file) => existsSync(file)),
  ...(await readdir(websiteDocs, { recursive: true })).filter((file) => /\.mdx?$/.test(file)).sort().map((file) => join(websiteDocs, file)),
]
const docImports = (await Promise.all(documented.map(async (file) => {
  const text = await readFile(file, "utf8")
  const blocks = Array.from(text.matchAll(/^```(?:ts|typescript|tsx|mts|js|javascript|mjs)\b[^\n]*\n([\s\S]*?)^```/gm))
  const statement = /import\s+(type\s+)?((?:[A-Za-z_$][\w$]*\s*,\s*)?(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*))\s+from\s+["']([^"']+)["']/g
  return blocks.flatMap((block) => Array.from((block[1] ?? "").matchAll(statement)).filter((found) => (found[3] ?? "").startsWith("@xandreed/")).map((found) => ({
    where: `${relative(root, file)}:${text.slice(0, (block.index ?? 0) + (block[0].indexOf(found[0]))).split("\n").length}`,
    typeOnly: found[1] !== undefined,
    clause: found[2] ?? "",
    from: found[3] ?? "",
  })))
}))).flat()
const aliased = docImports.flatMap((entry, index) => {
  const named = /\{([^}]*)\}/.exec(entry.clause)
  const namespace = /\*\s+as\s+[A-Za-z_$][\w$]*/.test(entry.clause)
  const defaulted = /^\s*[A-Za-z_$][\w$]*\s*(,|$)/.test(entry.clause)
  const names = (named?.[1] ?? "").split(",").map((part) => part.trim()).filter((part) => part.length > 0).map((part) => {
    const typeOnly = part.startsWith("type ")
    return { typeOnly, name: (typeOnly ? part.slice(5) : part).split(/\s+as\s+/)[0]?.trim() ?? "" }
  })
  const keyword = entry.typeOnly ? "import type" : "import"
  return [
    `// ${entry.where}`,
    ...names.map((item, position) => `${keyword} { ${item.typeOnly ? "type " : ""}${item.name} as doc${index}_${position} } from ${JSON.stringify(entry.from)}`),
    ...(namespace ? [`${keyword} * as doc${index}_ns from ${JSON.stringify(entry.from)}`] : []),
    ...(defaulted ? [`${keyword} doc${index}_default from ${JSON.stringify(entry.from)}`] : []),
  ]
})
await writeFile(join(consumer, "doc-imports.ts"), `// Every @xandreed import of the documentation, as written there (scripts/verify-packages.ts).\n${aliased.join("\n")}\nexport {}\n`)
console.log(`Checking ${docImports.length} documented imports from ${documented.length} files`)
/**
 * The events guide's HTTP recipe, as the guide shows it: its regions of the
 * test that runs it, with the imports they use, as one module the consumer
 * compiles against the packed packages and `events-consumer.mjs` runs on
 * Node and on Bun.
 */
const guideTest = await readFile(join(root, "packages/sdk/src/events-guide.test.ts"), "utf8")
const recipeRegions = ["host", "progress", "stream", "push", "journal", "project", "turn-route", "create-route", "events-route", "ping"]
const { regions: guideRegions } = regionsOf(guideTest)
const missingRegions = recipeRegions.filter((name) => !guideRegions.has(name))
const recipeCode = recipeRegions.map((name) => guideRegions.get(name) ?? "").join("\n\n")
const recipeImports = importsFor(importsOf(guideTest), recipeCode)
if (missingRegions.length > 0 || recipeImports.problems.length > 0) {
  console.error(`The events guide's recipe: ${[...missingRegions.map((name) => `no #region ${name}`), ...recipeImports.problems].join("; ")}`)
  process.exit(1)
}
await writeFile(join(consumer, "events-recipe.ts"), `// The events guide's HTTP recipe: regions of packages/sdk/src/events-guide.test.ts (scripts/verify-packages.ts).\n${recipeImports.lines.join("\n")}\n\n${recipeCode}\n`)
await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: "ESNext", module: "ESNext", moduleResolution: "bundler", types: ["bun"] }, include: ["verify.ts", "doc-imports.ts", "events-recipe.ts"] }))
const typecheck = Bun.spawn(["bun", "node_modules/typescript/bin/tsc", "--noEmit"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await typecheck.exited !== 0) process.exit(1)
const verify = Bun.spawn(["bun", "verify.ts"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await verify.exited !== 0) process.exit(1)
// A plugin states the version of the package it ships in: graph fingerprints and the plugin reference carry it.
await writeFile(join(consumer, "plugin-versions.ts"), `
import { readFile } from "node:fs/promises"
const names: ReadonlyArray<string> = ${JSON.stringify(artifacts.map(({ manifest }) => String(manifest.name)).sort())}
const isPlugin = (value: unknown): value is { readonly id: string; readonly version: string } => typeof value === "object" && value !== null
  && "id" in value && "version" in value && "apiVersion" in value && "build" in value && "provides" in value
const found = await Promise.all(names.map(async (name) => {
  const manifest = JSON.parse(await readFile(\`node_modules/\${name}/package.json\`, "utf8")) as { readonly version: string }
  const plugins = [...new Set(Object.values(await import(name)).filter(isPlugin))]
  return plugins.map((plugin) => ({ name, id: plugin.id, version: plugin.version, expected: manifest.version }))
}))
const plugins = found.flat()
const mismatched = plugins.filter((plugin) => plugin.version !== plugin.expected)
if (plugins.length === 0 || mismatched.length > 0) {
  console.error(plugins.length === 0 ? "No plugin found in the packed packages" : mismatched.map((plugin) => \`\${plugin.id} (\${plugin.name}) says \${plugin.version}, its package is \${plugin.expected}\`).join("\\n"))
  process.exit(1)
}
console.log(\`\${plugins.length} plugins carry their package's version\`)
`)
const pluginVersions = Bun.spawn(["bun", "plugin-versions.ts"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await pluginVersions.exited !== 0) process.exit(1)
if (Bun.which("node") !== null) {
  // Every entry of a package that declares Node must load there: a Bun-only import fails here, not in a consumer's deploy.
  // A file no entry names stays out of reach: a deep import of core is refused.
  const nodeReady = artifacts.filter(({ manifest }) => manifest.engines?.node !== undefined).flatMap(({ manifest }) =>
    Object.keys(manifest.exports ?? { ".": "" }).filter((key) => !key.includes("*")).map((key) => key === "." ? String(manifest.name) : `${manifest.name}/${key.slice(2)}`))
  await writeFile(join(consumer, "node-imports.mjs"), nodeReady.map((name) => `await import(${JSON.stringify(name)})`).join("\n") + `
const deepImport = await import("@xandreed/core/turn/turn-event.entity.js").then(() => "loaded", (error) => error.code)
if (deepImport !== "ERR_PACKAGE_PATH_NOT_EXPORTED") { console.error("A deep import of @xandreed/core was not refused: " + deepImport); process.exit(1) }
console.log("${nodeReady.length} published entries load on Node, and core refuses a deep import")
const { encodeSse, FeedReady, renderSurfacePlugin } = await import("@xandreed/plugin-render")
if (renderSurfacePlugin.id !== "@xandreed/plugin-render/surface" || encodeSse(FeedReady.make({})) !== "event: ready\\ndata: {}\\n\\n") process.exit(1)
const { Context, Effect, Layer, Option, Schema, Stream } = await import("effect")
const { LanguageModel } = await import("effect/ai")
const { makeMemoryFileSystem, StepLoop } = await import("@xandreed/core")
const { fileSystemConformance, sessionLogRecoveryConformance, stepLoopConformance, turnConformance } = await import("@xandreed/core/conformance")
const { runSteps, STEP_LOOP, stepLoopPlugin } = await import("@xandreed/plugin-agent-loop")
const { memoryWindowPlugin } = await import("@xandreed/plugin-memory-window")
const { SessionsPluginLive } = await import("@xandreed/plugin-sessions")
const { toolDiscoveryPlugin } = await import("@xandreed/plugin-tool-discovery")
const { Agent, agentInboxRunner, Sessions, SessionLog, SessionLogMemoryLive, TurnAdmissionOpen } = await import("@xandreed/sdk")
// Run a kit's checks; any failure prints them all and fails the verification.
const runKit = async (kit, checks) => {
  const failures = (await Effect.runPromise(Effect.forEach(checks, (check) => Effect.result(check.run).pipe(
    Effect.map((result) => result._tag === "Failure" ? [kit + ": " + check.name + ": " + result.failure.message] : []))))).flat()
  if (failures.length > 0) { console.error(failures.join("\\n")); process.exit(1) }
  return checks.length
}
// An in-memory log reopens only when every open shares its store: build it once.
const memoryLog = await Effect.runPromise(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive)))
const recovery = await runKit("SessionLog recovery", sessionLogRecoveryConformance({ open: Effect.succeed(memoryLog), callerClock: true }))
// The durable store on Node: both SessionLog kits over the packed plugin-session-files, in a fresh directory.
const { makeSessionLogFiles } = await import("@xandreed/plugin-session-files")
const { sessionLogConformance } = await import("@xandreed/core/conformance")
const filesFs = await import("node:fs/promises")
const filesRoot = await filesFs.mkdtemp((await import("node:path")).join((await import("node:os")).tmpdir(), "efferent-node-files-"))
const filesLog = await Effect.runPromise(Effect.scoped(makeSessionLogFiles(filesRoot + "/kit")))
const filesKit = await runKit("SessionLog (files)", sessionLogConformance(filesLog))
const filesRecovery = await runKit("SessionLog recovery (files)", sessionLogRecoveryConformance({ open: makeSessionLogFiles(filesRoot + "/recovery"), callerClock: true }))
await filesFs.rm(filesRoot, { recursive: true, force: true })
const fileSystem = await runKit("FileSystem", fileSystemConformance({ open: makeMemoryFileSystem().pipe(Effect.tap((fs) => fs.mkdir("/work")), Effect.map((fs) => ({ fs, root: "/work", symlink: fs.symlink }))) }))
// The StepLoop and TurnRunner contracts (their usage totals among them) hold on Node too.
const stepLoop = await runKit("StepLoop", stepLoopConformance(StepLoop.of({ ...STEP_LOOP, run: runSteps })))
// Raw-result durability, run ordinals and presentation overlays hold over both packed memory strategies.
const { ConversationMemory, UtilityCompletion, UtilityLlm } = await import("@xandreed/core")
const { memoryConformance } = await import("@xandreed/core/conformance")
const { memorySummaryPlugin } = await import("@xandreed/plugin-memory-summary")
const memoryUtility = Context.make(UtilityLlm, UtilityLlm.of({ complete: () => Effect.succeed(new UtilityCompletion({
  text: "SUMMARY", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
})) }))
const memoryChecks = await Effect.runPromise(Effect.scoped(Effect.forEach([memoryWindowPlugin, memorySummaryPlugin], (plugin) =>
  plugin.build(plugin.defaults, Context.empty()).pipe(Effect.map((built) => memoryConformance(Context.get(built, ConversationMemory), memoryUtility).map((check) => ({ ...check, name: plugin.id + ": " + check.name })))),
  { concurrency: 1 })))
const memories = await runKit("ConversationMemory", memoryChecks.flat())
console.log("The packed window and summary memory strategies pass " + memories + " checks on Node, including raw-result durability and run ordinals")
// The turn kit brings its own model where it runs the loop; the one here is never called.
const turnServices = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const model = yield* LanguageModel.make({ generateText: () => Effect.die("not called"), streamText: () => Stream.die("not called") })
  const sessions = Context.get(yield* Layer.build(SessionsPluginLive({ ownership: { mode: "process" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  return Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions))
})))
const agent = Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], turnServices: [LanguageModel.LanguageModel], system: "Be brief." })
const turn = await runKit("turn", turnConformance(agent, turnServices))
const { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } = await import("node:fs/promises")
const { tmpdir } = await import("node:os")
const { join } = await import("node:path")
const { Bash, Capabilities, FileSystem, harnessCodeOf, ImageResizer, RunId, SessionEnvironment, UserMessage } = await import("@xandreed/core")
const { bashConformance, imageResizerConformance } = await import("@xandreed/core/conformance")
const { BashLive, FileSystemLive, ImageResizerCliLive, localSystemPlugin, SkillsDirectoryPluginLive, workspaceTools, workspaceToolsDefaults, GrepResult, workspaceToolsPlugin } = await import("@xandreed/plugin-workspace")
// The busy signal on Node: an open turn and a running task count, and awaitIdle sees both settle.
const { awaitIdle, processActivity, TaskRunner } = await import("@xandreed/core")
const { InProcessTaskRunnerLive } = await import("@xandreed/plugin-tasks")
const { Deferred, Scope, Exit } = await import("effect")
const busy = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const services = yield* Layer.build(InProcessTaskRunnerLive().pipe(Layer.provideMerge(SessionsPluginLive().pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen))))))
  const sessions = Context.get(services, Sessions)
  const view = yield* sessions.create({ owner: "node" })
  const scope = yield* Scope.make()
  const writer = yield* sessions.begin({ id: view.header.id, owner: "node" }, { _tag: "User", userMessage: new UserMessage({ text: "hello" }), runId: RunId.make("run-1"), key: "k1", command: {} }).pipe(Scope.provide(scope))
  const release = yield* Deferred.make()
  yield* Context.get(services, TaskRunner).run(() => Deferred.await(release))
  const during = yield* processActivity.pipe(Effect.provide(services))
  yield* writer.end({ reason: "completed", failure: Option.none() })
  yield* Scope.close(scope, Exit.void)
  yield* Deferred.succeed(release, undefined)
  const after = yield* awaitIdle({ timeout: "5 seconds" }).pipe(Effect.provide(services))
  return JSON.stringify([during.openTurns.length, during.beginningTurns, during.runningTasks, during.busy, after.busy])
})))
if (busy !== JSON.stringify([1, 0, 1, true, false])) { console.error("busy signal on Node: " + busy); process.exit(1) }
const linkTo = (target, path) => Effect.tryPromise(() => symlink(target, path))
// The model store kits over every adapter plugin-models ships: in memory, and on files in temporary directories.
const { ModelCatalog } = await import("@xandreed/core")
const { modelCatalogConformance } = await import("@xandreed/core/conformance")
const { authStoreConformance, modelRequestConformance, settingsStoreConformance } = await import("@xandreed/plugin-models/conformance")
const modelRequestChecks = await runKit("ModelRequest", modelRequestConformance())
if (modelRequestChecks !== 3) { console.error("the packed default request-policy kit did not run all three checks"); process.exit(1) }
const { AuthStore, ConfiguredModelCatalogLive, LocalAuthStoreLive, LocalSettingsStoreLive, MemoryAuthStoreLive, MemorySettingsStoreLive, ModelsTransport, SettingsStore } = await import("@xandreed/plugin-models")
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs")
const { dirname } = await import("node:path")
const { Redacted } = await import("effect")
const serviceOf =(tag, layer) => Effect.runPromise(Effect.service(tag).pipe(Effect.provide(layer)))
const kitHome = mkdtempSync(join(tmpdir(), "efferent-node-kits-home-"))
const kitCwd = mkdtempSync(join(tmpdir(), "efferent-node-kits-cwd-"))
// A token endpoint the refresh checks count and hold, and a file the corrupt checks damage, on Node's fetch and fs.
const tokenEndpoint = (provider) => {
  const state = { requests: 0, gate: Promise.resolve() }
  const fetch = async () => {
    state.requests += 1
    const count = state.requests
    await state.gate
    return Response.json({ access_token: "node-access-" + count, refresh_token: "node-refresh-" + count, expires_in: 3600 })
  }
  const hold = Effect.sync(() => {
    const gate = Promise.withResolvers()
    state.gate = gate.promise
    return Effect.sync(() => { state.gate = Promise.resolve(); gate.resolve() })
  })
  return { fetch, probe: { provider, requests: Effect.sync(() => state.requests), hold } }
}
const damagedFile = (path) => Effect.acquireRelease(Effect.sync(() => {
  const before = existsSync(path) ? Option.some(readFileSync(path)) : Option.none()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, "{ not json")
  return before
}), (before) => Effect.sync(() => Option.match(before, { onNone: () => rmSync(path, { force: true }), onSome: (bytes) => writeFileSync(path, bytes) })))
const memoryEndpoint = tokenEndpoint("anthropic")
const localEndpoint = tokenEndpoint("openai-codex")
const localAuth = LocalAuthStoreLive(kitCwd, kitHome, ".efferent/runtime").pipe(Layer.provide(Layer.succeed(ModelsTransport, ModelsTransport.of({ fetch: localEndpoint.fetch }))))
const stores = await runKit("AuthStore (memory)", authStoreConformance(await serviceOf(AuthStore, MemoryAuthStoreLive(new Map(), { fetch: memoryEndpoint.fetch })), { refresh: memoryEndpoint.probe }))
  + await runKit("AuthStore (local)", authStoreConformance(await serviceOf(AuthStore, localAuth), { refresh: localEndpoint.probe, corrupt: damagedFile(join(kitHome, ".efferent", "runtime", "auth.json")) }))
  + await runKit("SettingsStore (memory)", settingsStoreConformance(await serviceOf(SettingsStore, MemorySettingsStoreLive()), { writable: true }))
  + await runKit("SettingsStore (local)", settingsStoreConformance(await serviceOf(SettingsStore, LocalSettingsStoreLive(kitCwd, kitHome)), { writable: true, corrupt: damagedFile(join(kitCwd, ".efferent", "config.json")) }))
  + await runKit("ModelCatalog", modelCatalogConformance(await serviceOf(ModelCatalog, ConfiguredModelCatalogLive.pipe(Layer.provide(MemoryAuthStoreLive(new Map([["opencode", { type: "api_key", key: Redacted.make("k") }]]))))), { includes: ["opencode:glm-5.2"] }))
const messagesCatalog = await serviceOf(ModelCatalog, ConfiguredModelCatalogLive.pipe(Layer.provide(MemoryAuthStoreLive(new Map([
  ["anthropic", { type: "api_key", key: Redacted.make("catalog-fixture") }],
])))))
const featuredModels = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
const messagesCatalogChecks = await runKit("ModelCatalog Messages", modelCatalogConformance(messagesCatalog, { includes: featuredModels.map((model) => "anthropic:" + model) }))
const featuredEntries = await Effect.runPromise(messagesCatalog.list)
if (!featuredModels.every((model) => featuredEntries.some((entry) => entry.selection === "anthropic:" + model
  && entry.limits?.contextWindow === 1_000_000 && entry.limits?.maxOutputTokens === 128_000))) {
  console.error("the packed Messages catalog lost a featured model's neutral token limits"); process.exit(1)
}
const invalidCatalog = ModelCatalog.of({ list: Effect.succeed([{ selection: "anthropic:fixture", provider: "anthropic", credential: "api_key", limits: { maxOutputTokens: 0 } }]) })
const invalidLimitChecks = await Effect.runPromise(Effect.forEach(modelCatalogConformance(invalidCatalog), (check) => Effect.result(check.run).pipe(
  Effect.map((result) => result._tag === "Failure" ? [result.failure.check] : [])), { concurrency: 1 }).pipe(Effect.map((all) => all.flat())))
if (JSON.stringify(invalidLimitChecks) !== JSON.stringify(["decode"])) { console.error("the packed ModelCatalog kit accepted an invalid token limit"); process.exit(1) }
console.log("On Node, the four featured Messages models expose neutral token limits, and the ModelCatalog kit rejects an invalid bound (" + messagesCatalogChecks + " checks)")
rmSync(kitHome, { recursive: true, force: true })
rmSync(kitCwd, { recursive: true, force: true })
// The Sessions kit over the packed SessionsLive and in-memory log, each check under a TestClock of its own that the kit moves;
// the TaskRunner, Tasks and ToolRegistry kits over InProcessTaskRunnerLive, TasksLive and the tool discovery plugin.
const { TestClock } = await import("effect/testing")
const { InboxRunner, TaskActivity, TaskExecutor, Tasks, ToolRegistry, TurnActivity, TurnAdmission, TurnShutdown, WaitingInput, zeroUsage } = await import("@xandreed/core")
const { inboxRunnerConformance, sessionsConformance, taskRunnerConformance, tasksConformance } = await import("@xandreed/core/conformance")
const { toolRegistryConformance } = await import("@xandreed/sdk/conformance")
const { SessionsLive, sessionsDefaults } = await import("@xandreed/plugin-sessions")
const { TasksLive, tasksDefaults } = await import("@xandreed/plugin-tasks")
const { ToolDiscoveryLive, toolDiscoveryDefaults } = await import("@xandreed/plugin-tool-discovery")
const sharedLog = await Effect.runPromise(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive)))
const sessionsOver = (config, admission, liveness) => Layer.build(SessionsLive(config, liveness === undefined ? undefined : { liveness }).pipe(
  Layer.provide(Layer.merge(Layer.succeed(SessionLog, sharedLog), Layer.succeed(TurnAdmission, admission))))).pipe(
  Effect.map((context) => ({ sessions: Context.get(context, Sessions), activity: Context.getOption(context, TurnActivity), shutdown: Context.getOption(context, TurnShutdown), waitingInput: Context.getOption(context, WaitingInput) })))
const sessionChecks = sessionsConformance({
  leased: ({ ttlMs, admission }) => sessionsOver({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs, renew: "on-commit" } }, admission),
  processOwned: ({ self, running, admission }) => sessionsOver({ ...sessionsDefaults, ownership: { mode: "process" } }, admission,
    { current: Effect.succeed(Option.some(self)), alive: (pid) => Effect.succeed(running.includes(pid)) }),
  advance: (millis) => TestClock.adjust(millis),
}).map((check) => ({ name: check.name, run: check.run.pipe(Effect.provide(TestClock.layer())) }))
const sessionsKit = await runKit("Sessions", sessionChecks)
const inboxRunnerKit = await runKit("InboxRunner", inboxRunnerConformance({ open: ({ use }) => Effect.gen(function* () {
  const admission = yield* Effect.service(TurnAdmission).pipe(Effect.provide(TurnAdmissionOpen))
  const instance = yield* sessionsOver(sessionsDefaults, admission)
  const runner = { turn: (input) => "admitted" in input.turn ? use(input.turn).pipe(
    Effect.tap(() => Context.getUnsafe(input.services, Sessions) === instance.sessions ? Effect.void : Effect.die("wrong Sessions")),
    Effect.map((outcome) => ({ ...outcome, usage: zeroUsage })),
  ) : Effect.die("attempted a new turn") }
  const context = yield* Layer.build(agentInboxRunner(runner, { services: Context.empty() }).pipe(Layer.provide(Layer.succeed(Sessions, instance.sessions))))
  return Context.get(context, InboxRunner)
}) }))
const runnerKit = await runKit("TaskRunner", taskRunnerConformance(Layer.build(InProcessTaskRunnerLive()).pipe(
  Effect.map((context) => ({ runner: Context.get(context, TaskRunner), activity: Context.getOption(context, TaskActivity) })))))
const tasksKit = await runKit("Tasks", tasksConformance(({ runner, executor }) => Layer.build(TasksLive(tasksDefaults).pipe(Layer.provideMerge(Layer.mergeAll(
  SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, sharedLog), TurnAdmissionOpen))),
  Layer.succeed(TaskRunner, runner), Layer.succeed(TaskExecutor, executor))))).pipe(
  Effect.map((context) => ({ sessions: Context.get(context, Sessions), tasks: Context.get(context, Tasks), shutdown: Context.getOption(context, TurnShutdown) })))))
const registryKit = await runKit("ToolRegistry", toolRegistryConformance((capabilities, limits) => Layer.build(ToolDiscoveryLive({ ...toolDiscoveryDefaults, ...limits }).pipe(
  Layer.provide(Layer.succeed(Capabilities, capabilities)))).pipe(Effect.map((context) => Context.get(context, ToolRegistry)))))
console.log("${nodeReady.length} packages import on Node; plugin-render encodes, and on Node the SessionLog recovery kit passes over the memory log (" + recovery + " checks), both SessionLog kits over the file store in a directory (" + filesKit + " and " + filesRecovery + "), the FileSystem kit over the memory file system (" + fileSystem + "), the StepLoop kit over runSteps (" + stepLoop + "), the turn kit over Agent.turn (" + turn + "), the busy signal over SessionsPluginLive and InProcessTaskRunnerLive, the AuthStore, SettingsStore and ModelCatalog kits over plugin-models' adapters (" + stores + "), the Sessions kit over SessionsLive and the memory log (" + sessionsKit + "), the InboxRunner kit over agentInboxRunner (" + inboxRunnerKit + "), the TaskRunner kit over InProcessTaskRunnerLive (" + runnerKit + "), the Tasks kit over TasksLive (" + tasksKit + ") and the ToolRegistry kit over the tool discovery plugin (" + registryKit + ")")
${localKits}
${workspaceJourney}
`)
  const node = Bun.spawn(["node", "node-imports.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
  if (await node.exited !== 0) process.exit(1)
  // The file store's crash recovery on Node: the package's holder, run with node over the packed package, killed while it
  // commits, then the directory read whole; and two node processes racing by compare-and-swap.
  await writeFile(join(consumer, "session-files-holder.mjs"), await readFile(join(root, "packages/plugin-session-files/fixtures/session-files-holder.mjs"), "utf8"))
  await writeFile(join(consumer, "files-crash.mjs"), `
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Option } from "effect"
import { ConversationId } from "@xandreed/core"
import { makeSessionLogFiles } from "@xandreed/plugin-session-files"
const root = await mkdtemp(join(tmpdir(), "efferent-node-crash-"))
const withLog = (body) => Effect.runPromise(Effect.scoped(makeSessionLogFiles(root).pipe(Effect.flatMap(body))))
const fresh = async () => { const id = ConversationId.make(crypto.randomUUID()); await withLog((log) => log.create({ id, owner: "node", origin: "user", createdAt: 0, meta: {}, parent: Option.none() })); return id }
const holder = (...args) => new Promise((resolve, reject) => {
  const child = spawn("node", ["session-files-holder.mjs", ...args], { stdio: ["pipe", "pipe", "inherit"] })
  const said = []
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk) => { said.push(...String(chunk).split("\\n").filter((line) => line.length > 0)); if (said.includes("ready")) resolve({ child, said }) })
  child.on("exit", () => reject(new Error("the holder stopped before it was ready: " + said.join(" "))))
})
const exited = (child) => new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal ?? code)))
const crashed = await fresh()
const writer = await holder("commit-loop", root, crashed, "5")
await new Promise((resolve) => setTimeout(resolve, 300))
writer.child.kill("SIGKILL")
await exited(writer.child)
const head = await withLog((log) => log.head(crashed))
const events = await withLog((log) => log.read(crashed, { after: 0, limit: Option.none(), kinds: [] }))
const wholeCommits = head.revision >= 1 && events.length === head.revision * 5 && events.every((event, index) => event.seq === index + 1 && event.data.commit === Math.floor(index / 5) + 1) && head.state.commit === head.revision
if (!wholeCommits) { console.error("a node writer killed mid-commit left " + events.length + " events at revision " + head.revision); process.exit(1) }
const raced = await fresh()
const racers = await Promise.all([holder("cas-increments", root, raced, "100", "a"), holder("cas-increments", root, raced, "100", "b")])
racers.forEach(({ child }) => child.stdin.write("go\\n"))
await Promise.all(racers.map(({ child }) => exited(child)))
const count = (await withLog((log) => log.head(raced))).state.count
if (count !== 200) { console.error("two node processes racing by compare-and-swap counted " + count + ", not 200"); process.exit(1) }
await rm(root, { recursive: true, force: true })
console.log("On Node, the file store kept whole commits after a writer was killed mid-commit (revision " + head.revision + "), and two processes racing by compare-and-swap lost no update")
`)
  const filesCrash = Bun.spawn(["node", "files-crash.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
  if (await filesCrash.exited !== 0) process.exit(1)
} else console.log("node not on PATH: skipped the Node import check")
// The same real agent restart journey runs on both packed runtimes: kill a
// tool holder, and kill again after atomic steering take, before recovering
// the original work and then its queued next input with no lease advance.
await writeFile(join(consumer, "inbox-restart-consumer.mjs"), await readFile(join(root, "scripts/inbox-restart-consumer.fixture.mjs"), "utf8"))
const inboxRestartNode = Bun.spawn(["node", "inbox-restart-consumer.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await inboxRestartNode.exited !== 0) process.exit(1)
const inboxRestartBun = Bun.spawn(["bun", "inbox-restart-consumer.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await inboxRestartBun.exited !== 0) process.exit(1)
registry.stop(true)
await writeFile(join(consumer, "evaluation-consumer.mjs"), await readFile(join(root, "scripts/evaluation-consumer.fixture.mjs"), "utf8"))
const evalNode = Bun.spawn(["node", "evaluation-consumer.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await evalNode.exited !== 0) process.exit(1)
// A turn with the packed telemetry plugin exports its agent.turn span and usage metric over OTLP to a
// node:http collector: on Node, the runtime a serverless host deploys to, then on Bun.
await writeFile(join(consumer, "telemetry-consumer.mjs"), await readFile(join(root, "scripts/telemetry-consumer.fixture.mjs"), "utf8"))
const telemetryNode = Bun.spawn(["node", "telemetry-consumer.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await telemetryNode.exited !== 0) process.exit(1)
const telemetryBun = Bun.spawn(["bun", "telemetry-consumer.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await telemetryBun.exited !== 0) process.exit(1)
// The events guide's HTTP recipe (events-recipe.ts, compiled above) serves a streamed turn, its retry and its
// journal over SSE through the packed packages: on Node, which runs the recipe's TypeScript by stripping its types, then on Bun.
await writeFile(join(consumer, "events-consumer.mjs"), await readFile(join(root, "scripts/events-consumer.fixture.mjs"), "utf8"))
const eventsNode = Bun.spawn(["node", "events-consumer.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await eventsNode.exited !== 0) process.exit(1)
const eventsBun = Bun.spawn(["bun", "events-consumer.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await eventsBun.exited !== 0) process.exit(1)
// The models plugin with storage "memory" never touches disk: on Node, in a process of its own whose HOME
// and working directory are fresh empty directories (the consumer's own already holds files) that must stay empty.
await writeFile(join(consumer, "models-consumer.mjs"), await readFile(join(root, "scripts/models-consumer.fixture.mjs"), "utf8"))
const freshHome = await mkdtemp(join(tmpdir(), "efferent-models-home-"))
const freshCwd = await mkdtemp(join(tmpdir(), "efferent-models-cwd-"))
const modelsNode = Bun.spawn(["node", join(consumer, "models-consumer.mjs")], {
  cwd: freshCwd, stdout: "inherit", stderr: "inherit",
  env: { ...process.env, HOME: freshHome, USERPROFILE: freshHome, MODELS_FIXTURE_KEY: "env-fixture-key" },
})
if (await modelsNode.exited !== 0) process.exit(1)
if ((await readdir(freshHome)).length > 0 || (await readdir(freshCwd)).length > 0) { console.error("The memory-storage models consumer wrote to its HOME or working directory"); process.exit(1) }
await rm(freshHome, { recursive: true, force: true })
await rm(freshCwd, { recursive: true, force: true })
// Real Agent turns through a local Messages server, settled and SSE, preserve
// opaque thinking signatures, native controls, durable tool-call identity and
// cache policies over a frozen stable-prefix/volatile-tail boundary.
await writeFile(join(consumer, "anthropic-messages-consumer.mjs"), await readFile(join(root, "scripts/anthropic-messages-consumer.fixture.mjs"), "utf8"))
const messagesNode = Bun.spawn(["node", "anthropic-messages-consumer.mjs", "--prompt-cache"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const messagesNodeReport = await new Response(messagesNode.stdout).text()
if (await messagesNode.exited !== 0 || !messagesNodeReport.includes('anthropic-messages {"runtime":"Node"') || (messagesNodeReport.match(/"cacheVerified":true/g) ?? []).length !== 7) {
  console.error("the packed Node Messages fixture did not complete its real HTTP turns"); process.exit(1)
}
console.log(messagesNodeReport.trim())
const messagesBun = Bun.spawn(["bun", "anthropic-messages-consumer.mjs", "--prompt-cache"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const messagesBunReport = await new Response(messagesBun.stdout).text()
if (await messagesBun.exited !== 0 || !messagesBunReport.includes('anthropic-messages {"runtime":"Bun"') || (messagesBunReport.match(/"cacheVerified":true/g) ?? []).length !== 7) {
  console.error("the packed Bun Messages fixture did not complete its real HTTP turns"); process.exit(1)
}
console.log(messagesBunReport.trim())
// Permanent model failures retain exact durable codes; irreducible context
// failures run no tools, while ordinary output limits keep bounded correctives.
await writeFile(join(consumer, "model-failures-consumer.mjs"), await readFile(join(root, "scripts/model-failures-consumer.fixture.mjs"), "utf8"))
const failuresNode = Bun.spawn(["node", "model-failures-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const failuresNodeReport = await new Response(failuresNode.stdout).text()
if (await failuresNode.exited !== 0 || !failuresNodeReport.includes('model-failures {"runtime":"Node"') || (failuresNodeReport.match(/"failureVerified":true/g) ?? []).length !== 13 || (failuresNodeReport.match(/"accountingVerified":true/g) ?? []).length !== 13) {
  console.error("the packed Node model-failure fixture did not preserve permanent failure behavior"); process.exit(1)
}
console.log(failuresNodeReport.trim())
const failuresBun = Bun.spawn(["bun", "model-failures-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const failuresBunReport = await new Response(failuresBun.stdout).text()
if (await failuresBun.exited !== 0 || !failuresBunReport.includes('model-failures {"runtime":"Bun"') || (failuresBunReport.match(/"failureVerified":true/g) ?? []).length !== 13 || (failuresBunReport.match(/"accountingVerified":true/g) ?? []).length !== 13) {
  console.error("the packed Bun model-failure fixture did not preserve permanent failure behavior"); process.exit(1)
}
console.log(failuresBunReport.trim())
// One request policy owns physical sends and pending reads; tools run after
// response handoff and the loop's explicit fallback keeps its frozen header.
await writeFile(join(consumer, "model-retry-consumer.mjs"), await readFile(join(root, "scripts/model-retry-consumer.fixture.mjs"), "utf8"))
const retryNode = Bun.spawn(["node", "model-retry-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const retryNodeReport = await new Response(retryNode.stdout).text()
if (await retryNode.exited !== 0 || !retryNodeReport.includes('model-retry {"runtime":"Node"') || (retryNodeReport.match(/"retryVerified":true/g) ?? []).length !== 16 || (retryNodeReport.match(/"accountingVerified":true/g) ?? []).length !== 16) {
  console.error("the packed Node request-policy fixture did not preserve bounded attempts and reads"); process.exit(1)
}
console.log(retryNodeReport.trim())
const retryBun = Bun.spawn(["bun", "model-retry-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const retryBunReport = await new Response(retryBun.stdout).text()
if (await retryBun.exited !== 0 || !retryBunReport.includes('model-retry {"runtime":"Bun"') || (retryBunReport.match(/"retryVerified":true/g) ?? []).length !== 16 || (retryBunReport.match(/"accountingVerified":true/g) ?? []).length !== 16) {
  console.error("the packed Bun request-policy fixture did not preserve bounded attempts and reads"); process.exit(1)
}
console.log(retryBunReport.trim())
// Billed calls include helpers and late plugin finalizers while selected
// turn usage remains the loop's own response usage.
await writeFile(join(consumer, "model-call-consumer.mjs"), await readFile(join(root, "scripts/model-call-consumer.fixture.mjs"), "utf8"))
const callNode = Bun.spawn(["node", "model-call-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const callNodeReport = await new Response(callNode.stdout).text()
if (await callNode.exited !== 0 || !callNodeReport.includes('model-call {"runtime":"Node"') || !callNodeReport.includes('"accountingVerified":true')) {
  console.error("the packed Node call-accounting fixture lost helper usage or double counted selected usage"); process.exit(1)
}
console.log(callNodeReport.trim())
const callBun = Bun.spawn(["bun", "model-call-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const callBunReport = await new Response(callBun.stdout).text()
if (await callBun.exited !== 0 || !callBunReport.includes('model-call {"runtime":"Bun"') || !callBunReport.includes('"accountingVerified":true')) {
  console.error("the packed Bun call-accounting fixture lost helper usage or double counted selected usage"); process.exit(1)
}
console.log(callBunReport.trim())
// A public durable-recorder kit proves terminal ACK and observer lifetime
// contracts over packed SDK composition and the real session writer.
await writeFile(join(consumer, "model-call-recorder-consumer.mjs"), await readFile(join(root, "scripts/model-call-recorder-consumer.fixture.mjs"), "utf8"))
const recorderNode = Bun.spawn(["node", "model-call-recorder-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const recorderNodeReport = await new Response(recorderNode.stdout).text()
if (await recorderNode.exited !== 0 || !recorderNodeReport.includes('model-call-recorder {"runtime":"Node","checks":6,"recorderVerified":true}')) {
  console.error("the packed Node model-call recorder failed its public conformance kit"); process.exit(1)
}
console.log(recorderNodeReport.trim())
const recorderBun = Bun.spawn(["bun", "model-call-recorder-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const recorderBunReport = await new Response(recorderBun.stdout).text()
if (await recorderBun.exited !== 0 || !recorderBunReport.includes('model-call-recorder {"runtime":"Bun","checks":6,"recorderVerified":true}')) {
  console.error("the packed Bun model-call recorder failed its public conformance kit"); process.exit(1)
}
console.log(recorderBunReport.trim())
// Accepted request input calibrates maintenance after the loop; manual
// composition shares that lifecycle without another scope requirement.
await writeFile(join(consumer, "memory-maintenance-consumer.mjs"), await readFile(join(root, "scripts/memory-maintenance-consumer.fixture.mjs"), "utf8"))
const maintenanceNode = Bun.spawn(["node", "memory-maintenance-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const maintenanceNodeReport = await new Response(maintenanceNode.stdout).text()
if (await maintenanceNode.exited !== 0 || !maintenanceNodeReport.includes('memory-maintenance {"runtime":"Node","summaries":1,"manualAfterRun":1,"maintenanceVerified":true}')) {
  console.error("the packed Node maintenance lifecycle lost accepted input, timing or manual completion"); process.exit(1)
}
console.log(maintenanceNodeReport.trim())
const maintenanceBun = Bun.spawn(["bun", "memory-maintenance-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const maintenanceBunReport = await new Response(maintenanceBun.stdout).text()
if (await maintenanceBun.exited !== 0 || !maintenanceBunReport.includes('memory-maintenance {"runtime":"Bun","summaries":1,"manualAfterRun":1,"maintenanceVerified":true}')) {
  console.error("the packed Bun maintenance lifecycle lost accepted input, timing or manual completion"); process.exit(1)
}
console.log(maintenanceBunReport.trim())
// Recovery sends one provably smaller same-step request, preserves actual route
// limits and accounting, and declines after visible output or without progress.
await writeFile(join(consumer, "context-overflow-consumer.mjs"), await readFile(join(root, "scripts/context-overflow-consumer.fixture.mjs"), "utf8"))
const overflowNode = Bun.spawn(["node", "context-overflow-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const overflowNodeReport = await new Response(overflowNode.stdout).text()
if (await overflowNode.exited !== 0 || !overflowNodeReport.includes('context-overflow {"runtime":"Node"') || (overflowNodeReport.match(/"recoveryVerified":true/g) ?? []).length !== 9 || (overflowNodeReport.match(/"replayVerified":true/g) ?? []).length !== 9 || (overflowNodeReport.match(/"accountingVerified":true/g) ?? []).length !== 9) {
  console.error("the packed Node context-overflow fixture lost bounded recovery, replay or accounting"); process.exit(1)
}
console.log(overflowNodeReport.trim())
const overflowBun = Bun.spawn(["bun", "context-overflow-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const overflowBunReport = await new Response(overflowBun.stdout).text()
if (await overflowBun.exited !== 0 || !overflowBunReport.includes('context-overflow {"runtime":"Bun"') || (overflowBunReport.match(/"recoveryVerified":true/g) ?? []).length !== 9 || (overflowBunReport.match(/"replayVerified":true/g) ?? []).length !== 9 || (overflowBunReport.match(/"accountingVerified":true/g) ?? []).length !== 9) {
  console.error("the packed Bun context-overflow fixture lost bounded recovery, replay or accounting"); process.exit(1)
}
console.log(overflowBunReport.trim())
// The default resolver kit verifies references independently of storage; the
// files journey then proves deduplication, lineage order and committed ACK loss.
await writeFile(join(consumer, "request-header-consumer.mjs"), await readFile(join(root, "scripts/request-header-consumer.fixture.mjs"), "utf8"))
await writeFile(join(consumer, "request-parts-consumer.mjs"), await readFile(join(root, "scripts/request-parts-consumer.fixture.mjs"), "utf8"))
for (const [binary, runtime] of [["node", "Node"], ["bun", "Bun"]] as const) {
  const headerChild = Bun.spawn([binary, "request-header-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
  const headerReport = await new Response(headerChild.stdout).text()
  if (await headerChild.exited !== 0 || !headerReport.includes(`request-header {"runtime":"${runtime}","checks":5,"hashVectors":9,"headerVerified":true}`)) {
    console.error(`the packed ${runtime} request resolver or UTF-8 hash vectors failed`); process.exit(1)
  }
  console.log(headerReport.trim())
  const partsChild = Bun.spawn([binary, "request-parts-consumer.mjs"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
  const partsReport = await new Response(partsChild.stdout).text()
  const required = ["dedupVerified", "coldRestartVerified", "forkCutoffVerified", "coldForkVerified", "integrityVerified", "prefixVerified", "heldAckRestartVerified", "durableBeforeAck", "atomicDependencyBatch", "noWritesVerified"]
  if (await partsChild.exited !== 0 || !partsReport.includes(`request-parts {"runtime":"${runtime}"`) || required.some((name) => !partsReport.includes(`"${name}":true`)) || (partsReport.match(/"noDispatchVerified":true/g) ?? []).length !== 2 || (partsReport.match(/"replayVerified":true/g) ?? []).length !== 6) {
    console.error(`the packed ${runtime} request-parts journey lost replay, deduplication, fork visibility or durable ACK recovery`); process.exit(1)
  }
  console.log(partsReport.trim())
}
// The models plugin's proxy transport on Node (undici, the WebSocket agent), with NODE_USE_ENV_PROXY on and the
// environment proxies pointing at a port nothing listens on, which Node's own fetch would send everything to.
await writeFile(join(consumer, "proxy-consumer.mjs"), await readFile(join(root, "scripts/proxy-consumer.fixture.mjs"), "utf8"))
const deadPort = await new Promise<number>((resolve) => {
  const probe = createServer()
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address()
    probe.close(() => resolve(typeof address === "object" && address !== null ? address.port : 9))
  })
})
const quietEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(https?|no|all)_proxy$/i.test(name)))
const proxyNode = Bun.spawn(["node", join(consumer, "proxy-consumer.mjs")], {
  cwd: consumer, stdout: "inherit", stderr: "inherit",
  env: { ...quietEnv, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${deadPort}`, HTTPS_PROXY: `http://127.0.0.1:${deadPort}` },
})
if (await proxyNode.exited !== 0) process.exit(1)
// The installed bin runs as a command, which needs the shebang the build keeps.
const evalBin = Bun.spawn([join(consumer, "node_modules/.bin/efferent-eval"), "--help"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const evalHelp = await new Response(evalBin.stdout).text()
if (await evalBin.exited !== 0 || !evalHelp.startsWith("efferent-eval ")) { console.error("The efferent-eval bin did not run as a command"); process.exit(1) }
console.log("The efferent-eval bin runs as a command")
console.log(`Packed consumer verified at ${consumer}`)
