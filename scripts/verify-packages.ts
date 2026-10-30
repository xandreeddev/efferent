import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { Result, Schema } from "effect"
import { apiBuildOf, apiDifferences, apiSnapshot, committedApi } from "./api-snapshot.js"
import { isTestCode, verifyRefusals } from "./build-check.js"
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
await writeFile(join(workspaceRoot, "notes.md"), "- buy milk\\n")
const workspacePixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
await writeFile(join(workspaceRoot, "chart.png"), Buffer.from(workspacePixel, "base64"))
const workspaceUsage = { inputTokens: { total: 3 }, outputTokens: { total: 1 } }
const workspaceCalls = [
 { name: "read", params: { path: "notes.md" } },
 { name: "load_skill", params: { skills: ["workspace.edit", "workspace.shell"] } },
 { name: "edit", params: { path: "notes.md", edits: [{ oldText: "milk", newText: "oat milk" }] } },
 { name: "bash", params: { command: "cat notes.md -; echo \\"$WORKSPACE_PROBE\\"", stdin: "from stdin\\n" } },
 { name: "read", params: { path: "chart.png" } },
]
const workspaceScript = JSON.parse(JSON.stringify([
 ...workspaceCalls.map((step, at) => [{ type: "tool-call", id: "w" + at, name: step.name, params: step.params }, { type: "finish", reason: "tool-calls", usage: workspaceUsage }]),
 [{ type: "text", text: "done" }, { type: "finish", reason: "stop", usage: workspaceUsage }],
]))
const workspacePrompts = JSON.parse("[]")
const workspaceTurn = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
 const sessions = Context.get(yield* Layer.build(SessionsPluginLive({ ownership: { mode: "process" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
 const agent = yield* Agent.define({
  plugins: [memoryWindowPlugin, { plugin: toolDiscoveryPlugin, options: { grants: ["fs.write", "shell.exec"] } }, stepLoopPlugin, localSystemPlugin, { plugin: workspaceToolsPlugin, options: { bashEnv: { WORKSPACE_PROBE: "probe" } } }],
  turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 7 }, workspace: workspaceRoot,
 })
 const model = yield* LanguageModel.make({
  generateText: (options) => Effect.sync(() => workspaceScript[workspacePrompts.push(JSON.stringify(options.prompt.content)) - 1]),
  streamText: () => Stream.die("not scripted"),
 })
 const view = yield* sessions.create({ owner: "consumer" })
 return yield* agent.turn({ turn: { session: { id: view.header.id, owner: "consumer" }, userMessage: new UserMessage({ text: "make it oat milk" }), runId: RunId.make("workspace-1") }, services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)) },
  (turn) => turn.tools.select(turn.userMessage).pipe(Effect.andThen(turn.run({})), Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) }))))
})))
const workspaceNotes = await readFile(join(workspaceRoot, "notes.md"), "utf8")
await rm(workspaceRoot, { recursive: true, force: true })
const workspaceLast = String(workspacePrompts[workspacePrompts.length - 1] ?? "")
// The image read's tool result: its text the one-line view (no base64), the image a file part of its modelOutput.
const workspaceRead = [...JSON.parse(workspaceLast || "[]")].filter((message) => message.role === "tool").flatMap((message) => [...message.content])
 .find((part) => part.result === "[Image chart.png (image/png, 70 B).]")
const workspaceImageSent = workspaceRead !== undefined && [...(workspaceRead.modelOutput ?? [])].some((output) => output.type === "file" && output.mediaType === "image/png" && output.data === workspacePixel)
if (workspaceTurn.outcome !== "completed" || workspaceNotes !== "- buy oat milk\\n" || !workspaceLast.includes("- buy oat milk\\\\nfrom stdin\\\\nprobe\\\\n[Exit code 0.]")
 || !workspaceImageSent) {
 console.error("The workspace tools journey failed: " + JSON.stringify({ outcome: workspaceTurn.outcome, notes: workspaceNotes, last: workspaceLast.slice(-600) }))
 process.exit(1)
}
console.log("The workspace tools read, edited and ran a command (stdin, host variable) and read an image in an Agent.turn on " + (typeof Bun === "undefined" ? "Node" : "Bun"))
`
await writeFile(join(consumer, "verify.ts"), `
import { Context, Deferred, Effect, Layer, Option, Ref, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { connect, createServer } from "node:net"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { awaitIdle, Bash, bashConformance, Capabilities, FileSystem, fileSystemConformance, makeMemoryFileSystem, RunId, Sessions, SessionEnvironment, SessionLogMemoryLive, sessionLogRecoveryConformance, TaskActivity, TaskExecutor, Tasks, TurnActivity, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { TurnWriter } from "@xandreed/core"
import { modelsPlugin } from "@xandreed/plugin-models"
import { BashLive, FileSystemLive, localSystemPlugin, SkillsDirectoryPluginLive, workspaceToolsPlugin } from "@xandreed/plugin-workspace"
import { makeSessionLogSqlite, SessionLogSqliteLive } from "@xandreed/plugin-session-sqlite"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive, TasksPluginLive } from "@xandreed/plugin-tasks"
import { Agent } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { assessAll, semanticEvaluator } from "@xandreed/evals"
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
const assessments = await Effect.runPromise(assessAll([{evaluator:rubric,select:["supported"]}],{answer:"fixture"}).pipe(Effect.provide(SemanticJevLive({evaluate:()=>Promise.resolve({answers:{supported:{type:"boolean",probability:0.9}}})}))))
if(assessments[0]?.status!=="scored" || assessments[0]?.metadata.backend!=="jev") process.exit(1)
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
  // Every package that declares Node must load there: a Bun-only import fails here, not in a consumer's deploy.
  const nodeReady = artifacts.filter(({ manifest }) => manifest.engines?.node !== undefined).map(({ manifest }) => String(manifest.name))
  await writeFile(join(consumer, "node-imports.mjs"), nodeReady.map((name) => `await import(${JSON.stringify(name)})`).join("\n") + `
const { encodeSse, FeedReady, renderSurfacePlugin } = await import("@xandreed/plugin-render")
if (renderSurfacePlugin.id !== "@xandreed/plugin-render/surface" || encodeSse(FeedReady.make({})) !== "event: ready\\ndata: {}\\n\\n") process.exit(1)
const { Context, Effect, Layer, Option, Stream } = await import("effect")
const { LanguageModel } = await import("effect/ai")
const { fileSystemConformance, makeMemoryFileSystem, Sessions, SessionLog, SessionLogMemoryLive, sessionLogRecoveryConformance, StepLoop, stepLoopConformance, TurnAdmissionOpen, turnConformance } = await import("@xandreed/core")
const { runSteps, STEP_LOOP, stepLoopPlugin } = await import("@xandreed/plugin-agent-loop")
const { memoryWindowPlugin } = await import("@xandreed/plugin-memory-window")
const { SessionsPluginLive } = await import("@xandreed/plugin-sessions")
const { toolDiscoveryPlugin } = await import("@xandreed/plugin-tool-discovery")
const { Agent } = await import("@xandreed/sdk")
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
const fileSystem = await runKit("FileSystem", fileSystemConformance({ open: makeMemoryFileSystem().pipe(Effect.tap((fs) => fs.mkdir("/work")), Effect.map((fs) => ({ fs, root: "/work", symlink: fs.symlink }))) }))
// The StepLoop and TurnRunner contracts (their usage totals among them) hold on Node too.
const stepLoop = await runKit("StepLoop", stepLoopConformance(StepLoop.of({ ...STEP_LOOP, run: runSteps })))
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
const { Bash, bashConformance, Capabilities, FileSystem, RunId, SessionEnvironment, UserMessage } = await import("@xandreed/core")
const { BashLive, FileSystemLive, localSystemPlugin, SkillsDirectoryPluginLive, workspaceToolsPlugin } = await import("@xandreed/plugin-workspace")
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
const { authStoreConformance, AuthStore, ModelCatalog, modelCatalogConformance, SettingsStore, settingsStoreConformance } = await import("@xandreed/core")
const { ConfiguredModelCatalogLive, LocalAuthStoreLive, LocalSettingsStoreLive, MemoryAuthStoreLive, MemorySettingsStoreLive, ModelsTransport } = await import("@xandreed/plugin-models")
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs")
const { dirname } = await import("node:path")
const serviceOf = (tag, layer) => Effect.runPromise(Effect.service(tag).pipe(Effect.provide(layer)))
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
  + await runKit("ModelCatalog", modelCatalogConformance(await serviceOf(ModelCatalog, ConfiguredModelCatalogLive.pipe(Layer.provide(MemoryAuthStoreLive(new Map([["opencode", { type: "api_key", key: "k" }]]))))), { includes: ["opencode:glm-5.2"] }))
rmSync(kitHome, { recursive: true, force: true })
rmSync(kitCwd, { recursive: true, force: true })
// The Sessions kit over the packed SessionsLive and in-memory log, each check under a TestClock of its own that the kit moves;
// the TaskRunner, Tasks and ToolRegistry kits over InProcessTaskRunnerLive, TasksLive and the tool discovery plugin.
const { TestClock } = await import("effect/testing")
const { sessionsConformance, taskRunnerConformance, tasksConformance, toolRegistryConformance, TaskActivity, TaskExecutor, Tasks, ToolRegistry, TurnActivity, TurnAdmission } = await import("@xandreed/core")
const { SessionsLive, sessionsDefaults } = await import("@xandreed/plugin-sessions")
const { TasksLive, tasksDefaults } = await import("@xandreed/plugin-tasks")
const { ToolDiscoveryLive, toolDiscoveryDefaults } = await import("@xandreed/plugin-tool-discovery")
const sharedLog = await Effect.runPromise(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive)))
const sessionsOver = (config, admission, liveness) => Layer.build(SessionsLive(config, liveness === undefined ? undefined : { liveness }).pipe(
  Layer.provide(Layer.merge(Layer.succeed(SessionLog, sharedLog), Layer.succeed(TurnAdmission, admission))))).pipe(
  Effect.map((context) => ({ sessions: Context.get(context, Sessions), activity: Context.getOption(context, TurnActivity) })))
const sessionChecks = sessionsConformance({
  leased: ({ ttlMs, admission }) => sessionsOver({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs, renew: "on-commit" } }, admission),
  processOwned: ({ self, running, admission }) => sessionsOver({ ...sessionsDefaults, ownership: { mode: "process" } }, admission,
    { current: Effect.succeed(Option.some(self)), alive: (pid) => Effect.succeed(running.includes(pid)) }),
  advance: (millis) => TestClock.adjust(millis),
}).map((check) => ({ name: check.name, run: check.run.pipe(Effect.provide(TestClock.layer())) }))
const sessionsKit = await runKit("Sessions", sessionChecks)
const runnerKit = await runKit("TaskRunner", taskRunnerConformance(Layer.build(InProcessTaskRunnerLive()).pipe(
  Effect.map((context) => ({ runner: Context.get(context, TaskRunner), activity: Context.getOption(context, TaskActivity) })))))
const tasksKit = await runKit("Tasks", tasksConformance(({ runner, executor }) => Layer.build(TasksLive(tasksDefaults).pipe(Layer.provideMerge(Layer.mergeAll(
  SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, sharedLog), TurnAdmissionOpen))),
  Layer.succeed(TaskRunner, runner), Layer.succeed(TaskExecutor, executor))))).pipe(
  Effect.map((context) => ({ sessions: Context.get(context, Sessions), tasks: Context.get(context, Tasks) })))))
const registryKit = await runKit("ToolRegistry", toolRegistryConformance((capabilities, limits) => Layer.build(ToolDiscoveryLive({ ...toolDiscoveryDefaults, ...limits }).pipe(
  Layer.provide(Layer.succeed(Capabilities, capabilities)))).pipe(Effect.map((context) => Context.get(context, ToolRegistry)))))
console.log("${nodeReady.length} packages import on Node; plugin-render encodes, and on Node the SessionLog recovery kit passes over the memory log (" + recovery + " checks), the FileSystem kit over the memory file system (" + fileSystem + "), the StepLoop kit over runSteps (" + stepLoop + "), the turn kit over Agent.turn (" + turn + "), the busy signal over SessionsPluginLive and InProcessTaskRunnerLive, the AuthStore, SettingsStore and ModelCatalog kits over plugin-models' adapters (" + stores + "), the Sessions kit over SessionsLive and the memory log (" + sessionsKit + "), the TaskRunner kit over InProcessTaskRunnerLive (" + runnerKit + "), the Tasks kit over TasksLive (" + tasksKit + ") and the ToolRegistry kit over the tool discovery plugin (" + registryKit + ")")
${localKits}
${workspaceJourney}
`)
  const node = Bun.spawn(["node", "node-imports.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
  if (await node.exited !== 0) process.exit(1)
} else console.log("node not on PATH: skipped the Node import check")
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
