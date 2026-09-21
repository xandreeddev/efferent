import { Context } from "effect"
export class Value extends Context.Tag("test/Value")<Value, number>() {}
export class Consumer extends Context.Tag("test/Consumer")<Consumer, number>() {}
