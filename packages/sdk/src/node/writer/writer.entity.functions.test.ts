import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { holderNumberOf, verdictOf } from "./writer.entity.functions.js"

const me = { pid: 40, host: "here" }
const file = (number: number) => `writer/${number}.json`
const holder = (pid: number, host: string) => ({ pid, host, token: "t", since: 0 })

describe("the writer lock's rules", () => {
  test("what an opener does about the highest holder file it found, as a table", () => {
    const rows = [
      ["nothing held", verdictOf({ _tag: "None" }, me, false, file)],
      ["a live holder here", verdictOf({ _tag: "Holding", number: 3, holder: holder(7, "here") }, me, true, file)],
      ["a gone holder here", verdictOf({ _tag: "Holding", number: 3, holder: holder(7, "here") }, me, false, file)],
      ["a holder with this process's id", verdictOf({ _tag: "Holding", number: 3, holder: holder(40, "here") }, me, true, file)],
      ["a holder on another machine", verdictOf({ _tag: "Holding", number: 3, holder: holder(7, "there") }, me, false, file)],
      ["a file that names no holder", verdictOf({ _tag: "Unreadable", number: 2 }, me, false, file)],
    ] as const
    expect(rows.map(([name, verdict]) => [name, verdict._tag === "Take" ? verdict.number : verdict.why])).toEqual([
      ["nothing held", 1],
      ["a live holder here", "held by process 7 on here, since 1970-01-01T00:00:00.000Z, which is running; if it is not the store's writer, stop it, or remove writer/3.json once it is gone"],
      ["a gone holder here", 4],
      ["a holder with this process's id", 4],
      ["a holder on another machine", "held by process 7 on there, since 1970-01-01T00:00:00.000Z, another machine, whose processes this one cannot see; if that process is gone, remove writer/3.json"],
      ["a file that names no holder", "the lock file writer/2.json does not name a holder; if no process holds the store, remove it"],
    ])
  })

  test("a holder file is a number and .json; a file being written and anything else are not", () => {
    expect(["1.json", "12.json", "0.json", "01.json", "3.json.abc.tmp", "x.json", "3.jsonl"].map((name) => Option.getOrUndefined(holderNumberOf(name))))
      .toEqual([1, 12, undefined, undefined, undefined, undefined, undefined])
  })
})
