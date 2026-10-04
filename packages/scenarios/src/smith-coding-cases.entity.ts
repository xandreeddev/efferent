import { Schema } from "effect"

export const SMITH_CODING_DATASET_VERSION = "1"
export const SmithCodingCase = Schema.Struct({
  id: Schema.NonEmptyString,
  task: Schema.NonEmptyString,
  seed: Schema.Record(Schema.String, Schema.String),
  solution: Schema.Record(Schema.String, Schema.String),
})
export type SmithCodingCase = typeof SmithCodingCase.Type

/** Public subject input. The scripted transport owns solution bytes separately. */
export const SmithCodingTask = Schema.Struct({ id: Schema.NonEmptyString, task: Schema.NonEmptyString, seed: Schema.Record(Schema.String, Schema.String), paths: Schema.Array(Schema.NonEmptyString) })
export type SmithCodingTask = typeof SmithCodingTask.Type

const foundations = `Use Effect 4 (effect/ai for AI), Schema contracts, const bindings, typed errors and native concurrency. Preserve tests, configuration and untouched.txt. Only edit the requested src files. Run bun test and bun run check before claiming completion.`

export const smithCodingCases: ReadonlyArray<SmithCodingCase> = [
  {
    id: "schema-boundary",
    task: `${foundations}\nCreate src/profile.entity.ts exporting branded ProfileId and Schema.Class Profile with id, name and email, all non-empty strings. Create src/profile.entity.functions.ts exporting decodeProfile(unknown), a Schema-decoding Effect, and normalizeProfile(Profile), a pure function trimming name and email and lowercasing email. Preserve the branded id.`,
    seed: {
      "tests/acceptance.test.ts": `import { expect, test } from "bun:test"\nimport { Effect, Result } from "effect"\nimport { decodeProfile, normalizeProfile } from "../src/profile.entity.functions.ts"\ntest("normalization preserves identity and malformed input fails as a value", async () => {\n const profile = await Effect.runPromise(decodeProfile({id:"p-1",name:" Ada ",email:" ADA@EXAMPLE.COM "}))\n expect(normalizeProfile(profile)).toMatchObject({id:"p-1",name:"Ada",email:"ada@example.com"})\n const invalid = await Effect.runPromise(Effect.result(decodeProfile({id:"",name:"Ada",email:"a@b"})))\n expect(Result.isFailure(invalid)).toBe(true)\n})\n`,
    },
    solution: {
      "src/profile.entity.ts": `import { Schema } from "effect"\nexport const ProfileId = Schema.NonEmptyString.pipe(Schema.brand("ProfileId"))\nexport type ProfileId = typeof ProfileId.Type\nexport class Profile extends Schema.Class<Profile>("Profile")({id:ProfileId,name:Schema.NonEmptyString,email:Schema.NonEmptyString}) {}\n`,
      "src/profile.entity.functions.ts": `import { Schema } from "effect"\nimport { Profile } from "./profile.entity.ts"\nexport const decodeProfile = Schema.decodeUnknownEffect(Profile)\nexport const normalizeProfile = (profile: Profile): Profile => new Profile({...profile,name:profile.name.trim(),email:profile.email.trim().toLowerCase()})\n`,
    },
  },
  {
    id: "service-isolation",
    task: `${foundations}\nCreate src/counter.port.ts exporting Counter, a Context.Service with next: Effect<number>. Create src/counter.adapter.ts exporting CounterLive, a Layer allocating a Ref-backed counter per build. next returns increasing numbers starting at 1. Two fresh builds must have independent counters.`,
    seed: {
      "tests/acceptance.test.ts": `import { expect, test } from "bun:test"\nimport { Effect, Layer } from "effect"\nimport { Counter } from "../src/counter.port.ts"\nimport { CounterLive } from "../src/counter.adapter.ts"\nconst run = Effect.gen(function*(){const counter = yield* Counter; return yield* Effect.all([counter.next,counter.next,counter.next])})\ntest("counter changes atomically and separate builds start fresh", async () => {\n expect(await Effect.runPromise(run.pipe(Effect.provide(CounterLive)))).toEqual([1,2,3])\n expect(await Effect.runPromise(run.pipe(Effect.provide(Layer.fresh(CounterLive))))).toEqual([1,2,3])\n})\n`,
    },
    solution: {
      "src/counter.port.ts": `import { Context } from "effect"\nimport type { Effect } from "effect"\nexport class Counter extends Context.Service<Counter,{readonly next:Effect.Effect<number>}>()("fixture/Counter") {}\n`,
      "src/counter.adapter.ts": `import { Effect, Layer, Ref } from "effect"\nimport { Counter } from "./counter.port.ts"\nexport const CounterLive = Layer.effect(Counter,Effect.gen(function*(){const value = yield* Ref.make(0); return Counter.of({next:Ref.updateAndGet(value,(number)=>number+1)})}))\n`,
    },
  },
  {
    id: "native-concurrency",
    task: `${foundations}\nCreate src/map-values.usecase.ts exporting Schema contract MapValues with values: number[]. Create src/map-values.usecase.functions.ts exporting generic mapConcurrent(values, worker), returning an Effect that maps with concurrency exactly 2, preserves input order and interrupts unfinished workers on cancellation. Do not use Promise.all or manual fibers.`,
    seed: {
      "tests/acceptance.test.ts": `import { expect, test } from "bun:test"\nimport { Effect, Ref } from "effect"\nimport { mapConcurrent } from "../src/map-values.usecase.functions.ts"\ntest("bounded native concurrency keeps input order", async () => {\n const result = await Effect.runPromise(Effect.gen(function*(){\n  const active = yield* Ref.make(0), maximum = yield* Ref.make(0)\n  const worker = (value:number) => Ref.updateAndGet(active,(n)=>n+1).pipe(Effect.tap((n)=>Ref.update(maximum,(old)=>Math.max(old,n))),Effect.andThen(Effect.sleep((5-value)*5)),Effect.as(value*2),Effect.ensuring(Ref.update(active,(n)=>n-1)))\n  const values = yield* mapConcurrent([1,2,3,4],worker)\n  return {values,maximum:yield* Ref.get(maximum),active:yield* Ref.get(active)}\n }))\n expect(result).toEqual({values:[2,4,6,8],maximum:2,active:0})\n})\ntest("cancellation releases both unfinished workers", async () => {\n const active = await Effect.runPromise(Effect.gen(function*(){\n  const count = yield* Ref.make(0)\n  const worker = (_:number) => Ref.update(count,(n)=>n+1).pipe(Effect.andThen(Effect.never),Effect.ensuring(Ref.update(count,(n)=>n-1)))\n  yield* mapConcurrent([1,2,3],worker).pipe(Effect.timeoutOption(20))\n  return yield* Ref.get(count)\n }))\n expect(active).toBe(0)\n})\n`,
    },
    solution: {
      "src/map-values.usecase.ts": `import { Schema } from "effect"\nexport const MapValues = Schema.Struct({values:Schema.Array(Schema.Number)})\nexport type MapValues = typeof MapValues.Type\n`,
      "src/map-values.usecase.functions.ts": `import { Effect } from "effect"\nexport const mapConcurrent = <A,E,R>(values:ReadonlyArray<number>,worker:(value:number)=>Effect.Effect<A,E,R>):Effect.Effect<ReadonlyArray<A>,E,R> => Effect.forEach(values,worker,{concurrency:2})\n`,
    },
  },
  {
    id: "effect-ai-failure",
    task: `${foundations}\nCreate src/echo.entity.ts exporting Failure = Schema.Struct({error:Schema.String,message:Schema.String}) and its derived type. Create src/echo.entity.functions.ts exporting echo(text): an Effect returning trimmed text, or Failure{error:'Empty',message:'Text is empty'} for blank text. Create src/echo-tool.adapter.ts exporting echoToolkit and EchoHandlersLive. The native effect/ai Tool 'echo' accepts {text:string}, returns a string, and declares Failure with failureMode:'return'. Its thin handler delegates to echo.`,
    seed: {
      "tests/acceptance.test.ts": `import { expect, test } from "bun:test"\nimport { Effect, Stream } from "effect"\nimport { echoToolkit, EchoHandlersLive } from "../src/echo-tool.adapter.ts"\ntest("native toolkit returns failures as data and can recover on the next call", async () => {\n const results = await Effect.runPromise(Effect.gen(function*(){\n  const toolkit = yield* echoToolkit\n  const failed = yield* toolkit.handle("echo",{text:" "}).pipe(Effect.flatMap(Stream.runCollect))\n  const success = yield* toolkit.handle("echo",{text:" fixed "}).pipe(Effect.flatMap(Stream.runCollect))\n  return {failed,success}\n }).pipe(Effect.provide(EchoHandlersLive)))\n expect(echoToolkit.tools.echo.failureMode).toBe("return")\n expect(results.failed[0]).toMatchObject({isFailure:true,result:{error:"Empty",message:"Text is empty"}})\n expect(results.success[0]).toMatchObject({isFailure:false,result:"fixed"})\n})\n`,
    },
    solution: {
      "src/echo.entity.ts": `import { Schema } from "effect"\nexport const Failure = Schema.Struct({error:Schema.String,message:Schema.String})\nexport type Failure = typeof Failure.Type\n`,
      "src/echo.entity.functions.ts": `import { Effect } from "effect"\nimport type { Failure } from "./echo.entity.ts"\nexport const echo = (text:string):Effect.Effect<string,Failure> => text.trim().length===0 ? Effect.fail({error:"Empty",message:"Text is empty"}) : Effect.succeed(text.trim())\n`,
      "src/echo-tool.adapter.ts": `import { Schema } from "effect"\nimport { Tool, Toolkit } from "effect/ai"\nimport { Failure } from "./echo.entity.ts"\nimport { echo } from "./echo.entity.functions.ts"\nconst Echo = Tool.make("echo",{description:"Echo trimmed text.",parameters:Schema.Struct({text:Schema.String}),success:Schema.String,failure:Failure,failureMode:"return"})\nexport const echoToolkit = Toolkit.make(Echo)\nexport const EchoHandlersLive = echoToolkit.toLayer({echo:({text})=>echo(text)})\n`,
    },
  },
]
