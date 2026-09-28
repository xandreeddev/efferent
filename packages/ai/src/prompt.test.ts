import { describe, expect, test } from "bun:test"
import { LanguageModel, Prompt } from "@effect/ai"
import { Effect, FiberRef, Option, Ref, Schema, Stream } from "effect"
import { CurrentPromptProvenance, PromptId } from "@xandreed/core"
import type { HarnessError } from "@xandreed/core"
import type { PromptContext, PromptProvenance } from "@xandreed/core"
import { sha256Hex } from "./hash.adapter.js"
import { CurrentModelTarget } from "./ports/model-target.port.js"
import {
  composeVariant,
  decodeTarget,
  definePrompt,
  encodeTarget,
  generateObject,
  generateText,
  promptSection,
  renderPrompt,
  selectVariant,
  withProvenance,
} from "./prompt.entity.functions.js"

/** A prompt with a baseline, a concise variant, and overrides for one provider and one model. */
const summary = definePrompt({
  id: "test.summary",
  version: "summary-v1",
  render: (input: { readonly text: string }) => [
    { role: "system", content: "Summarize the user's text." },
    { role: "user", content: input.text },
  ],
  variants: {
    baseline: { shared: [] },
    concise: {
      shared: [{ role: "system", content: "Be concise." }],
      providers: { openai: [{ role: "system", content: "Be concise, in plain words." }] },
      models: { "openai/gpt-small": [{ role: "system", content: "One sentence." }] },
    },
  },
  output: () => ({ name: "summary", schema: Schema.Struct({ summary: Schema.String }) }),
})

const systemTexts = (prompt: Prompt.Prompt) => prompt.content.map((message) => `${message.role}:${typeof message.content === "string" ? message.content : "…"}`)
const expectedHash = (prompt: Prompt.Prompt) => new Bun.CryptoHasher("sha256").update(JSON.stringify(Schema.encodeSync(Prompt.Prompt)(prompt))).digest("hex")

/** A provider that records the prompt and the provenance of each call. */
const recording = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<{ readonly prompt: Prompt.Prompt; readonly provenance: Option.Option<PromptProvenance> }>>([])
  const model = yield* LanguageModel.make({
    generateText: (options) => FiberRef.get(CurrentPromptProvenance).pipe(
      Effect.flatMap((provenance) => Ref.update(calls, (all) => [...all, { prompt: options.prompt, provenance }])),
      Effect.as((options.responseFormat.type === "json"
        ? [{ type: "text", text: JSON.stringify({ summary: "short" }) }, { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]
        : [{ type: "text", text: "a summary" }, { type: "finish", reason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }]) as never),
    ),
    streamText: () => Stream.die("not streamed") as never,
  })
  return { calls, model }
})

describe("versioned prompts", () => {
  test("SHA-256 is lowercase hex of the UTF-8 bytes", async () => {
    expect(await Effect.runPromise(sha256Hex("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })

  test("the most specific fragment applies: the model, then the provider, then shared; an unknown variant fails", async () => {
    const variants = { concise: { shared: "shared", providers: { openai: "provider" }, models: { "openai/gpt-small": "model" } } }
    const pick = (model: string, variant = "concise") => Effect.runPromise(Effect.either(selectVariant(variants, { model, variant })))
    expect(await pick("openai/gpt-small")).toMatchObject({ _tag: "Right", right: { fragment: "model", override: Option.some("openai/gpt-small") } })
    expect(await pick("openai/gpt-large")).toMatchObject({ _tag: "Right", right: { fragment: "provider", override: Option.some("openai") } })
    expect(await pick("other/model")).toMatchObject({ _tag: "Right", right: { fragment: "shared", override: Option.none() } })
    expect(await pick("openai/gpt-small", "constructor")).toMatchObject({ _tag: "Left", left: { code: "variant.unknown" } })
  })

  test("a fragment goes after the system messages and before the rest", () => {
    const base = Prompt.make([{ role: "system", content: "A" }, { role: "user", content: "question" }])
    expect(systemTexts(composeVariant(base, Prompt.make([{ role: "system", content: "B" }])))).toEqual(["system:A", "system:B", "user:…"])
    expect(composeVariant(base, Prompt.empty)).toBe(base)
  })

  test("rendering records the provenance of the composed prompt, for an explicit or the current target", async () => {
    const [baseline, overridden, current] = await Effect.runPromise(Effect.all([
      renderPrompt(summary, { text: "long text" }, { model: "other/model", variant: "baseline" }),
      renderPrompt(summary, { text: "long text" }, { model: "openai/gpt-small", variant: "concise" }),
      renderPrompt(summary, { text: "long text" }).pipe(Effect.provideService(CurrentModelTarget, { model: "openai/gpt-large", variant: "concise" })),
    ]))
    expect(systemTexts(baseline!.prompt)).toEqual(["system:Summarize the user's text.", "user:…"])
    expect(systemTexts(overridden!.prompt)).toEqual(["system:Summarize the user's text.", "system:One sentence.", "user:…"])
    expect(systemTexts(current!.prompt)).toEqual(["system:Summarize the user's text.", "system:Be concise, in plain words.", "user:…"])
    expect(baseline!.provenance).toEqual({ id: PromptId.make("test.summary"), version: "summary-v1", variant: "baseline", modelOverride: Option.none(), hash: expectedHash(baseline!.prompt) })
    expect(overridden!.provenance).toMatchObject({ variant: "concise", modelOverride: Option.some("openai/gpt-small"), hash: expectedHash(overridden!.prompt) })
    expect(current!.provenance).toMatchObject({ variant: "concise", modelOverride: Option.some("openai") })
    expect(baseline!.provenance.hash).not.toBe(overridden!.provenance.hash)
  })

  test("without a target or a CurrentModelTarget, a prompt renders its baseline; one without variants takes any variant", async () => {
    const plain = definePrompt({ id: "test.plain", version: "1", render: () => "hello" })
    const [base, any] = await Effect.runPromise(Effect.all([
      renderPrompt(summary, { text: "x" }),
      renderPrompt(plain, undefined, { model: "unknown", variant: "experimental" }),
    ]))
    expect(base!.provenance.variant).toBe("baseline")
    expect(any!.provenance).toMatchObject({ variant: "experimental", modelOverride: Option.none() })
  })

  test("withProvenance is what model adapters read", async () => {
    const read = await Effect.runPromise(Effect.gen(function* () {
      const rendered = yield* renderPrompt(summary, { text: "x" })
      return yield* FiberRef.get(CurrentPromptProvenance).pipe(withProvenance(rendered.provenance))
    }))
    expect(Option.map(read, (provenance) => String(provenance.id))).toEqual(Option.some("test.summary"))
  })

  test("generateText and generateObject send the composed prompt under its provenance", async () => {
    const { calls, text, object } = await Effect.runPromise(Effect.gen(function* () {
      const { calls, model } = yield* recording
      const target = { model: "openai/gpt-small", variant: "concise" }
      const text = yield* generateText(summary, { text: "long text" }, { target }).pipe(Effect.provideService(LanguageModel.LanguageModel, model))
      const object = yield* generateObject(summary, { text: "long text" }, { target }).pipe(Effect.provideService(LanguageModel.LanguageModel, model))
      return { calls: yield* Ref.get(calls), text: text.text, object: object.value }
    }))
    expect(text).toBe("a summary")
    expect(object).toEqual({ summary: "short" })
    expect(calls.map((call) => Option.map(call.provenance, (provenance) => `${provenance.id}/${provenance.variant}/${Option.getOrElse(provenance.modelOverride, () => "-")}`))).toEqual([
      Option.some("test.summary/concise/openai/gpt-small"), Option.some("test.summary/concise/openai/gpt-small"),
    ])
    expect(calls.map((call) => systemTexts(call.prompt).includes("system:One sentence."))).toEqual([true, true])
  })

  test("a prompt without an output cannot generate an object", async () => {
    const plain = definePrompt({ id: "test.plain", version: "1", render: () => "hello" })
    const exit = await Effect.runPromise(Effect.either(generateObject(plain, undefined).pipe(
      Effect.provideServiceEffect(LanguageModel.LanguageModel, recording.pipe(Effect.map((recorded) => recorded.model))),
    )))
    expect(exit).toMatchObject({ _tag: "Left", left: { _tag: "PromptError", code: "output.missing" } })
  })

  test("a prompt section renders the system messages for the encoded target", async () => {
    const guide = definePrompt({
      id: "test.guide", version: "1",
      render: (context: PromptContext) => [{ role: "system", content: `Tools: ${context.active.join(", ")}` }],
      variants: { baseline: { shared: [] }, concise: { shared: [{ role: "system", content: "Be brief." }] } },
    })
    const section = promptSection(guide, { id: "guide", version: "1", tier: "static", order: 0 })
    const render = (variant: Option.Option<string>) => Effect.runPromise(Effect.either(section.render({ variant, active: ["lookup"], skills: [] }) as Effect.Effect<Option.Option<string>, HarnessError>))
    const target = { model: "openai/gpt-small", variant: "concise" }
    expect(decodeTarget(encodeTarget(target))).toEqual(target)
    expect(await render(Option.some(encodeTarget(target)))).toMatchObject({ _tag: "Right", right: Option.some("Tools: lookup\n\nBe brief.") })
    expect(await render(Option.none())).toMatchObject({ _tag: "Right", right: Option.some("Tools: lookup") })
    expect(await render(Option.some("missing"))).toMatchObject({ _tag: "Left", left: { _tag: "HarnessError", code: "prompt.variant.unknown" } })
  })
})
