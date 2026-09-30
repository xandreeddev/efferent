import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
const root = join(import.meta.dir, "..")
/** The consumer installs the Effect the packages were built against. */
const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { readonly dependencies: { readonly effect: string } }
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
await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: { ...Object.fromEntries(artifacts.map(({manifest}) => [manifest.name,manifest.version])), effect: rootManifest.dependencies.effect, "@types/bun": "1.3.14" } }))
console.log(`Installing from temporary local registry into ${consumer}`)
const install = Bun.spawn(["bun", "install", "--ignore-scripts", "--no-cache", "--cache-dir", join(consumer, ".install-cache")], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await install.exited !== 0) process.exit(1)
await writeFile(join(consumer, "verify.ts"), `
import { Context, Deferred, Effect, Layer, Option, Schema } from "effect"
import { Sessions, TaskExecutor, Tasks, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { TurnWriter } from "@xandreed/core"
import { SessionLogSqliteLive } from "@xandreed/plugin-session-sqlite"
import { SessionsPluginLive } from "@xandreed/plugin-sessions"
import { InProcessTaskRunnerLive, TasksPluginLive } from "@xandreed/plugin-tasks"
import { CurrentPromptProvenance, defineDecisionPrompt, definePrompt, evaluateDecision, EvaluationModelLive, renderPrompt, withProvenance } from "@xandreed/ai"
import { AgentLoop, definePlugin, Harness } from "@xandreed/sdk"
import sessions from "@xandreed/plugin-session-sqlite"
import { sessionsPlugin } from "@xandreed/plugin-sessions"
import { scenario, runPack, assessAll, semanticEvaluator } from "@xandreed/evals"
import { SemanticJevLive } from "@xandreed/evals/adapters/semantic-jev.adapter"
const echo = definePlugin({ id: "external/echo", version: "1", config: Schema.Struct({prefix: Schema.String}), defaults: {prefix:"hello "}, provides:[AgentLoop], layer: ({prefix}) => Layer.succeed(AgentLoop,{ run: input => Effect.succeed({text:prefix+input.userMessage.text,outcome:"completed"}) }) })
await Effect.runPromise(Effect.scoped(Effect.gen(function*(){
 const harness = yield* Harness.make({workspace:process.cwd(), plugins:[sessions,sessionsPlugin,echo], config:{version:1,plugins:[{id:"store",use:sessions.id},{id:"session-service",use:sessionsPlugin.id,options:{ownership:{mode:"process"}}},{id:"loop",use:echo.id}]}})
 const session = yield* harness.create()
 yield* session.send("world")
 const last = (yield* session.history).at(-1)
 if(last?.data.text !== "hello world") return yield* Effect.die("external plugin did not execute")
 const fork = yield* harness.fork(session.record.id,last.seq)
 if((yield* fork.history).length===0) return yield* Effect.die("fork has no history")
})) )
const report = await Effect.runPromise(runPack({name:"external",threshold:1,scenarios:[scenario({name:"custom fixture",modes:["scripted"],boot:Effect.succeed(42),steps:[{name:"score",act:()=>Effect.void,checks:[{name:"custom scorer",severity:"hard",run:world=>Effect.succeed({pass:world===42})}]}]})]},"scripted"))
if(!report.passed) process.exit(1)
const rubric = semanticEvaluator({id:"external-quality",version:"1",questions:{supported:{type:"boolean",instructions:"Is the answer supported?"}},state:(input:{answer:string})=>input.answer})
const assessments = await Effect.runPromise(assessAll([{evaluator:rubric,select:["supported"]}],{answer:"fixture"}).pipe(Effect.provide(SemanticJevLive({evaluate:()=>Promise.resolve({answers:{supported:{type:"boolean",probability:0.9}}})}))))
if(assessments[0]?.status!=="scored" || assessments[0]?.metadata.backend!=="jev") process.exit(1)
console.log("External SDK, plugin, persistence, fork, eval composition, and optional rubric adapter passed")
const greeting = definePrompt({ id: "external.greeting", version: "1", render: (name: string) => [{ role: "system", content: "Greet the user." }, { role: "user", content: name }], variants: { baseline: { shared: [], models: { "vendor/small": [{ role: "system", content: "Be brief." }] } } } })
const small = await Effect.runPromise(renderPrompt(greeting, "Ada", { model: "vendor/small", variant: "baseline" }))
const large = await Effect.runPromise(renderPrompt(greeting, "Ada", { model: "vendor/large", variant: "baseline" }))
if (small.prompt.content.length !== 3 || large.prompt.content.length !== 2 || Option.getOrNull(small.provenance.modelOverride) !== "vendor/small" || Option.isSome(large.provenance.modelOverride)) process.exit(1)
const current = await Effect.runPromise(Effect.service(CurrentPromptProvenance).pipe(withProvenance(small.provenance)))
if (Option.getOrNull(current)?.hash !== small.provenance.hash || !/^[0-9a-f]{64}$/.test(small.provenance.hash) || small.provenance.hash === large.provenance.hash) process.exit(1)
const route = defineDecisionPrompt({ id: "external.route", version: "1", family: "routing", state: (text: string) => text, questions: () => ({ lane: { type: "choice", instructions: "Which lane?", criteria: { fast: "Quick.", slow: "Careful." } } }) })
const decide = (choice: string) => evaluateDecision(route, "hello").pipe(Effect.provide(EvaluationModelLive({ model: "stub/judge", transport: () => Promise.resolve({ answers: { lane: { type: "choice", choice } } }) })))
const chosen = await Effect.runPromise(decide("fast"))
const refused = await Effect.runPromise(Effect.result(decide("sideways")))
if (chosen.lane.choice !== "fast" || refused._tag !== "Failure" || refused.failure._tag !== "EvaluationError" || refused.failure.code !== "invalid") process.exit(1)
console.log("Versioned prompts, their provenance and a checked decision passed")
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
  await writeFile(join(consumer, "render-node.mjs"), `import { encodeSse, FeedReady, renderSurfacePlugin } from "@xandreed/plugin-render"
if (renderSurfacePlugin.id !== "@xandreed/plugin-render/surface" || encodeSse(FeedReady.make({})) !== "event: ready\\ndata: {}\\n\\n") process.exit(1)
console.log("plugin-render imports on Node")
`)
  const node = Bun.spawn(["node", "render-node.mjs"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
  if (await node.exited !== 0) process.exit(1)
} else console.log("node not on PATH: skipped the plugin-render Node import check")
const cli = Bun.spawn(["bun", "node_modules/@xandreed/cli/dist/main.js", "--help"], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await cli.exited !== 0) process.exit(1)
await writeFile(join(consumer, "tui-fixture.ts"), await readFile(join(root, "scripts/tui-fixture.ts"), "utf8"))
const terminal = Bun.spawn(["python", join(root, "scripts/verify-tui.py"), "--consumer", consumer], { cwd: consumer, stdout: "inherit", stderr: "inherit" })
if (await terminal.exited !== 0) process.exit(1)
registry.stop(true)
console.log(`Packed consumer verified at ${consumer}`)
