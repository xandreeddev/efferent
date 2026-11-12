import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { PluginName } from "./ids.entity.js"
import { planPlugins } from "./plugin.entity.functions.js"
import type { PluginNode } from "./plugin.entity.js"

/** A plugin as plain data: `name`, what it needs, and what it provides when it provides something. */
const plugin = (name: string, requires: ReadonlyArray<string> = [], provides?: string): PluginNode =>
  provides === undefined ? { name: PluginName.make(name), requires } : { name: PluginName.make(name), requires, provides }

/** The order planned, by name, or the refusal's reason, plugin and contract. */
const planned = (plugins: ReadonlyArray<PluginNode>, given: ReadonlyArray<string> = [], later?: ReadonlyArray<string>) =>
  Result.match(planPlugins(later === undefined ? { plugins, given } : { plugins, given, later }), {
    onSuccess: (order): unknown => order.map((each) => String(each.name)),
    onFailure: (refusal): unknown => ({ reason: refusal.reason, plugin: String(refusal.plugin), contract: refusal.contract }),
  })

describe("planning plugins from what they declare", () => {
  test("a set that fits is ordered: each plugin at its listed place, its later-listed providers just before it", () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<PluginNode>, ReadonlyArray<string>, ReadonlyArray<string>]> = [
      ["no plugins", [], [], []],
      ["nothing required: the listed order", [plugin("a"), plugin("b"), plugin("c")], [], ["a", "b", "c"]],
      ["providers nobody requires: the listed order", [plugin("a", [], "A"), plugin("b", [], "B")], [], ["a", "b"]],
      ["a requirement that is given moves nothing", [plugin("a", ["Core"]), plugin("b", ["Core"])], ["Core"], ["a", "b"]],
      ["a provider listed before its consumer stays there", [plugin("p", [], "P"), plugin("c", ["P"])], [], ["p", "c"]],
      ["a provider listed after its consumer is built just before it", [plugin("c", ["P"]), plugin("p", [], "P")], [], ["p", "c"]],
      ["the consumer keeps its place among the others: a needs c", [plugin("a", ["C"]), plugin("b"), plugin("c", [], "C")], [], ["c", "a", "b"]],
      ["only the provider moves: b needs c", [plugin("a"), plugin("b", ["C"]), plugin("c", [], "C")], [], ["a", "c", "b"]],
      ["a chain listed backwards", [plugin("x", ["Y"], "X"), plugin("y", ["Z"], "Y"), plugin("z", [], "Z")], [], ["z", "y", "x"]],
      ["two consumers of one provider keep their order", [plugin("a", ["P"]), plugin("b", ["P"]), plugin("p", [], "P")], [], ["p", "a", "b"]],
      ["a provider is pulled in front once", [plugin("a", ["P", "Q"]), plugin("q", ["P"], "Q"), plugin("p", [], "P")], [], ["p", "q", "a"]],
      ["two providers pulled in front keep their listed order", [plugin("a", ["P", "Q"]), plugin("p", [], "P"), plugin("q", [], "Q")], [], ["p", "q", "a"]],
      ["however the consumer spells its list", [plugin("a", ["Q", "P"]), plugin("p", [], "P"), plugin("q", [], "Q")], [], ["p", "q", "a"]],
      ["plugins that do not depend on each other keep the listed order around a moved one", [plugin("m", ["S"], "M"), plugin("l", ["M"], "L"), plugin("t"), plugin("s", [], "S"), plugin("u")], [], ["s", "m", "l", "t", "u"]],
    ]
    for (const [title, plugins, given, order] of cases) expect([title, planned(plugins, given)]).toEqual([title, order])
  })

  test("the same plugins listed in another order are planned by that order, each time the same", () => {
    const [a, b, c] = [plugin("a"), plugin("b"), plugin("c", [], "C")]
    expect(planned([a, b, c])).toEqual(["a", "b", "c"])
    expect(planned([c, b, a])).toEqual(["c", "b", "a"])
    expect(planned([b, a, c])).toEqual(planned([b, a, c]))
  })

  test("a set that does not fit is refused, naming the plugin and the contract", () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<PluginNode>, ReadonlyArray<string>, ReadonlyArray<string> | undefined, { readonly reason: string; readonly plugin: string; readonly contract: string }]> = [
      ["nothing provides what a plugin requires", [plugin("a"), plugin("c", ["P"])], [], undefined, { reason: "MissingProvider", plugin: "c", contract: "P" }],
      ["the first missing one is named", [plugin("c", ["Core", "P", "Q"])], ["Core"], undefined, { reason: "MissingProvider", plugin: "c", contract: "P" }],
      ["two plugins provide one contract: the second is named", [plugin("p", [], "P"), plugin("a"), plugin("q", [], "P")], [], undefined, { reason: "DuplicateProvider", plugin: "q", contract: "P" }],
      ["a plugin provides what is given already", [plugin("mine", [], "Core")], ["Core"], undefined, { reason: "DuplicateProvider", plugin: "mine", contract: "Core" }],
      ["a duplicate is told before a missing provider", [plugin("c", ["X"]), plugin("p", [], "P"), plugin("q", [], "P")], [], undefined, { reason: "DuplicateProvider", plugin: "q", contract: "P" }],
      ["a plugin requires what it provides itself", [plugin("self", ["S"], "S")], [], undefined, { reason: "Cycle", plugin: "self", contract: "S" }],
      ["two plugins require each other", [plugin("a", ["B"], "A"), plugin("b", ["A"], "B")], [], undefined, { reason: "Cycle", plugin: "b", contract: "A" }],
      ["three in a circle, behind one that is not in it", [plugin("free"), plugin("a", ["B"], "A"), plugin("b", ["C"], "B"), plugin("c", ["A"], "C")], [], undefined, { reason: "Cycle", plugin: "c", contract: "A" }],
      ["a plugin requires what exists only later", [plugin("store", ["Settings"], "Storage")], ["Core"], ["Settings"], { reason: "LaterContract", plugin: "store", contract: "Settings" }],
      ["later is told apart from missing", [plugin("store", ["Nothing"], "Storage")], ["Core"], ["Settings"], { reason: "MissingProvider", plugin: "store", contract: "Nothing" }],
    ]
    for (const [title, plugins, given, later, refusal] of cases) expect([title, planned(plugins, given, later)]).toEqual([title, refusal])
  })

  test("a refusal says what to do about it", () => {
    const message = (plugins: ReadonlyArray<PluginNode>) => Result.match(planPlugins({ plugins, given: [] }), { onSuccess: () => "planned", onFailure: (refusal) => refusal.message })
    expect(message([plugin("compress", ["app/Summaries"])])).toBe("plugin compress requires app/Summaries, which no plugin provides: add a plugin that provides it")
    expect(message([plugin("one", [], "app/Summaries"), plugin("two", [], "app/Summaries")])).toBe("plugins one and two both provide app/Summaries: list one of them")
    expect(message([plugin("a", ["B"], "A"), plugin("b", ["C"], "B"), plugin("c", ["A"], "C")])).toBe("plugin c requires A, whose provider needs c in turn: a → b → c → a")
    expect(message([plugin("self", ["S"], "S")])).toBe("plugin self requires S, whose provider needs self in turn: self → self")
  })

  test("no plugin is added: the order holds the plugins listed and no other", () => {
    const listed = [plugin("c", ["P"]), plugin("p", [], "P")]
    const order = Result.getOrThrow(planPlugins({ plugins: listed, given: [] }))
    expect(order).toHaveLength(2)
    expect(order[0]).toBe(listed[1])
    expect(order[1]).toBe(listed[0])
  })
})
