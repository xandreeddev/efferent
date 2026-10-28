import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const root = join(import.meta.dir, "..")
/** The consumer installs the Effect the packages were built against, and the repo's TypeScript. */
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { readonly dependencies: { readonly effect: string }, readonly devDependencies: { readonly typescript: string } }
const packages = join(root, ".artifacts/packages")
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
await writeFile(join(consumer, "verify.ts"), `
import { Context, Deferred, Effect, Layer, Option, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import { Sessions, SessionLogMemoryLive, TaskExecutor, Tasks, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { TurnWriter } from "@xandreed/core"
import { SessionLogSqliteLive } from "@xandreed/plugin-session-sqlite"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive, TasksPluginLive } from "@xandreed/plugin-tasks"
import { Agent } from "@xandreed/sdk"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { assessAll, semanticEvaluator } from "@xandreed/evals"
import { SemanticJevLive } from "@xandreed/evals"
const usage = { inputTokens: { total: 3 }, outputTokens: { total: 2 } }
const turned = await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
 const sessions = Context.get(yield* Layer.build(SessionsPluginLive({ ownership: { mode: "process" } }).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
 const agent = yield* Agent.define({ plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin], turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 2 }, system: "Be brief." })
 const model = yield* LanguageModel.make({
  generateText: (options) => Effect.succeed([{ type: "text", text: JSON.stringify(options.prompt).includes("world") ? "hello world" : "unseen" }, { type: "finish", reason: "stop", usage }] as never),
  streamText: () => Stream.die("not scripted") as never,
 })
 const view = yield* sessions.create({ owner: "consumer" })
 const address = { id: view.header.id, owner: "consumer" }
 const outcome = yield* agent.turn({ turn: { session: address, userMessage: new UserMessage({ text: "world" }), runId: "run-1" }, services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)) },
  (turn) => turn.run({}).pipe(Effect.map((result) => ({ outcome: result.outcome, reply: Option.some(result.text) }))))
 const fork = yield* sessions.fork(address, { origin: "fork", inherit: true })
 return { outcome, forked: fork.header.parent }
})) )
if (turned.outcome.outcome !== "completed" || Option.getOrNull(turned.outcome.reply) !== "hello world" || Option.isNone(turned.forked)) process.exit(1)
const rubric = semanticEvaluator({id:"external-quality",version:"1",questions:{supported:{type:"boolean",instructions:"Is the answer supported?"}},state:(input:{answer:string})=>input.answer})
const assessments = await Effect.runPromise(assessAll([{evaluator:rubric,select:["supported"]}],{answer:"fixture"}).pipe(Effect.provide(SemanticJevLive({evaluate:()=>Promise.resolve({answers:{supported:{type:"boolean",probability:0.9}}})}))))
if(assessments[0]?.status!=="scored" || assessments[0]?.metadata.backend!=="jev") process.exit(1)
console.log("Composable agent turn, session fork, eval composition and optional rubric adapter passed")
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
  const writer = yield* sessions.begin(address, { _tag: "User", userMessage: new UserMessage({ text: "hello" }), runId: "run-1", key: "k1", command: {} })
  yield* tasks.start(address, { instructions: "the answer", mode: "fork" })
  return (yield* writer.end({ reason: "completed", failure: Option.none() })).pending
 }))
 if (pending > 0) yield* sessions.drain(address, react)
 return yield* Deferred.await(done).pipe(Effect.timeout("5 seconds"))
})))
if (!answered.includes("found the answer")) process.exit(1)
console.log("Sessions over SQLite, a background task and the reaction to its result passed")
`)
await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: "ESNext", module: "ESNext", moduleResolution: "bundler", types: ["bun"] }, include: ["verify.ts"] }))
const typecheck = Bun.spawn(["bun", "node_modules/typescript/bin/tsc", "--noEmit"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await typecheck.exited !== 0) process.exit(1)
const verify = Bun.spawn(["bun", "verify.ts"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await verify.exited !== 0) process.exit(1)
if (Bun.which("node") !== null) {
  // Every package that declares Node must load there: a Bun-only import fails here, not in a consumer's deploy.
  const nodeReady = artifacts.filter(({ manifest }) => manifest.engines?.node !== undefined).map(({ manifest }) => String(manifest.name))
  await writeFile(join(consumer, "node-imports.mjs"), nodeReady.map((name) => `await import(${JSON.stringify(name)})`).join("\n") + `
const { encodeSse, FeedReady, renderSurfacePlugin } = await import("@xandreed/plugin-render")
if (renderSurfacePlugin.id !== "@xandreed/plugin-render/surface" || encodeSse(FeedReady.make({})) !== "event: ready\\ndata: {}\\n\\n") process.exit(1)
console.log("${nodeReady.length} packages import on Node; plugin-render encodes on Node")
`)
  const node = Bun.spawn(["node", "node-imports.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
  if (await node.exited !== 0) process.exit(1)
} else console.log("node not on PATH: skipped the Node import check")
registry.stop(true)
await writeFile(join(consumer, "evaluation-consumer.mjs"), await readFile(join(root, "scripts/evaluation-consumer.fixture.mjs"), "utf8"))
const evalNode = Bun.spawn(["node", "evaluation-consumer.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await evalNode.exited !== 0) process.exit(1)
// The installed bin runs as a command, which needs the shebang the build keeps.
const evalBin = Bun.spawn([join(consumer, "node_modules/.bin/efferent-eval"), "--help"], { cwd: consumer, stdout: "pipe", stderr: "inherit" })
const evalHelp = await new Response(evalBin.stdout).text()
if (await evalBin.exited !== 0 || !evalHelp.startsWith("efferent-eval ")) { console.error("The efferent-eval bin did not run as a command"); process.exit(1) }
console.log("The efferent-eval bin runs as a command")
console.log(`Packed consumer verified at ${consumer}`)
