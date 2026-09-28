import { Context } from "effect"
export class Value extends Context.Service<Value, number>()("test/Value") {}
export class Consumer extends Context.Service<Consumer, number>()("test/Consumer") {}
export class Items extends Context.Service<Items, ReadonlyArray<string>>()("test/Items") {}
