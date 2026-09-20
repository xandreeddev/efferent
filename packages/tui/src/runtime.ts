import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { createComponent } from "solid-js"
import { Cause, Chunk, Deferred, Effect, Fiber, Option, Ref, Runtime, Stream } from "effect"
import type { Harness, HarnessError, SessionHandle } from "@xandreed/sdk"
import { App } from "./App.js"
import { createTuiState, errorMessage } from "./state.js"
import type { Overlay, TuiState } from "./state.js"
import type { ApprovalChannel } from "./approval.js"
import type { EventRenderers } from "./projection.js"
import type { ThemeName } from "./theme.js"

export interface TuiCommand {
  readonly name: string
  readonly description: string
  readonly run: (argument: string, state: TuiState) => Effect.Effect<void, HarnessError>
}

export const runTui = (options: {
  readonly harness: Harness
  readonly session: SessionHandle
  readonly approvals: ApprovalChannel
  readonly commands?: ReadonlyArray<TuiCommand>
  readonly eventRenderers?: EventRenderers
  readonly theme?: ThemeName
  readonly model?: string
  readonly initialPrompt?: string
  readonly onReady?: (state: TuiState) => Effect.Effect<void, HarnessError>
  readonly beforeSend?: (text: string, state: TuiState) => Effect.Effect<boolean, HarnessError>
}) => Effect.scoped(Effect.gen(function* () {
  const scope = yield* Effect.scope
  const rt = yield* Effect.runtime<never>()
  const state = createTuiState(options.session.record, options.theme, options.eventRenderers)
  state.setModel(options.model ?? "")
  const selected = yield* Ref.make(options.session)
  const follower = yield* Ref.make(Option.none<Fiber.RuntimeFiber<void, HarnessError>>())
  const done = yield* Deferred.make<void>()
  const report = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.catchAllCause((cause) => Effect.sync(() => {
    const failure = Cause.failureOption(cause)
    if (Option.isSome(failure) && typeof failure.value === "object" && failure.value !== null && "code" in failure.value && failure.value.code === "run.failed") return
    state.setNotice(errorMessage(cause))
  })))
  const launch = <A, E>(effect: Effect.Effect<A, E>) => { Runtime.runFork(rt)(Effect.forkIn(report(effect), scope)) }
  const attach = (session: SessionHandle) => Effect.gen(function* () {
    yield* Ref.get(follower).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid) })))
    yield* Ref.set(selected, session)
    yield* Effect.sync(() => state.selectSession(session.record))
    const events = session.events().pipe(Stream.groupedWithin(64, "16 millis"), Stream.runForEach((events) => Effect.sync(() => state.events(Chunk.toReadonlyArray(events)))))
    const deltas = session.transient.pipe(Stream.groupedWithin(64, "16 millis"), Stream.runForEach((events) => Effect.sync(() => state.deltas(Chunk.toReadonlyArray(events)))))
    const fiber = yield* Effect.forkIn(Effect.all([events, deltas], { concurrency: "unbounded", discard: true }), scope)
    yield* Ref.set(follower, Option.some(fiber))
  })
  yield* attach(options.session)
  const closeOverlay = () => state.setOverlay({ kind: "none" })
  const commands: ReadonlyArray<TuiCommand> = [
    ...(options.commands ?? []),
    { name: "new", description: "Start a fresh session", run: () => options.harness.create().pipe(Effect.flatMap(attach)) },
    { name: "sessions", description: "Resume a previous conversation", run: () => options.harness.list.pipe(Effect.flatMap((records) => Effect.sync(() => state.setOverlay({ kind: "menu", title: "Sessions", rows: records.map((record) => ({ label: `${record.id.slice(0, 8)} · ${record.profile}`, detail: new Date(record.createdAt).toLocaleString(), select: () => launch(options.harness.resume(record.id).pipe(Effect.flatMap(attach))) })) })))) },
    { name: "continue", description: "Continue queued input after cancellation", run: () => Ref.get(selected).pipe(Effect.flatMap((session) => session.continue)) },
    { name: "search", description: "Search transcript: /search words", run: (query) => Effect.sync(() => { state.setSearch(query); closeOverlay(); state.setFollowing(true) }) },
    { name: "theme", description: "Choose dark, light, or mono", run: (argument) => Effect.sync(() => {
      if (["dark", "light", "mono"].includes(argument)) { state.setTheme(argument as ThemeName); closeOverlay(); return }
      state.setOverlay({ kind: "menu", title: "Appearance", rows: (["dark", "light", "mono"] as const).map((theme) => ({ label: theme, detail: "", select: () => { state.setTheme(theme); closeOverlay() } })) })
    }) },
    { name: "quit", description: "Close the terminal client", run: () => Deferred.succeed(done, undefined).pipe(Effect.asVoid) },
  ]
  const palette = () => state.setOverlay({ kind: "menu", title: "Commands", rows: commands.map((command) => ({ label: `/${command.name}`, detail: command.description, select: () => { closeOverlay(); launch(command.run("", state)) } })) })
  const submit = (text: string) => {
    state.setNotice("")
    if (text.trim() === "/") { palette(); return }
    if (text.startsWith("/")) {
      const [name, ...parts] = text.slice(1).split(/\s+/)
      const command = commands.find((entry) => entry.name === name)
      if (command === undefined) { state.setNotice(`Unknown command /${name}. Ctrl+P lists commands.`); return }
      launch(command.run(parts.join(" "), state)); return
    }
    launch((options.beforeSend?.(text, state) ?? Effect.succeed(true)).pipe(Effect.flatMap((ready) => ready
      ? Ref.get(selected).pipe(Effect.flatMap((session) => session.busy.pipe(Effect.flatMap((busy) => busy ? session.steer(text) : session.send(text)))))
      : Effect.void)))
  }
  yield* Effect.forkScoped(options.approvals.events.pipe(Stream.runForEach((request) => Effect.sync(() => {
    if (request.cancelled) { if (state.overlay().kind === "approval") closeOverlay(); return }
    state.setOverlay({ kind: "approval", description: request.description, answer: (allowed) => { closeOverlay(); launch(request.answer(allowed)) } })
  }))))
  const renderer = yield* Effect.acquireRelease(
    Effect.promise(() => createCliRenderer({ exitOnCtrlC: false, exitSignals: [], useMouse: true, targetFps: 30 })),
    (value) => Effect.sync(() => value.destroy()),
  )
  yield* Effect.promise(() => render(() => createComponent(App, { state, actions: {
    commands, submit, palette, interrupt: () => launch(Ref.get(selected).pipe(Effect.flatMap((session) => session.interrupt))),
    quit: () => launch(Deferred.succeed(done, undefined)),
  } }), renderer))
  if (options.onReady !== undefined) yield* report(options.onReady(state))
  if (options.initialPrompt?.trim()) submit(options.initialPrompt)
  yield* Deferred.await(done)
  yield* Ref.get(selected).pipe(Effect.flatMap((session) => session.interrupt))
}))

export type { Overlay }
