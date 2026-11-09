import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect, Fiber, Option } from "effect"
import { AttemptNumber, WorkspacePath } from "../domain/Brands.js"
import { ForgeLimits, Spec } from "../domain/Spec.js"
import { implementCommand, implementationPrompt } from "./claudeImplementor.js"

const spec = new Spec({ goal: "Add a reader", acceptance: ["reads bounded input"], limits: new ForgeLimits({ maxAttempts: 1, budgetMillis: 1000 }) })

test("implementation prompt includes the exact goal, acceptance and previous feedback", () => {
  expect(implementationPrompt(spec, Option.some("use the port"))).toBe("Implement the following in THIS directory (write TypeScript under ./src). Do not ask questions; just write the code.\n\n## Goal\nAdd a reader\n\n## Acceptance\n- reads bounded input\n\n## Previous attempt was rejected\nuse the port")
  expect(implementationPrompt(spec, Option.none())).toBe("Implement the following in THIS directory (write TypeScript under ./src). Do not ask questions; just write the code.\n\n## Goal\nAdd a reader\n\n## Acceptance\n- reads bounded input")
})

test("interrupting an implementor kills and reaps its child before returning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "foundry-implementor-"))
  await (async () => {
    const input = { spec, feedback: Option.none<string>(), attempt: AttemptNumber.make(1), workspaceDir: WorkspacePath.make(directory) }
    const command = [process.execPath, "-e", 'require("node:fs").writeFileSync("child.pid", String(process.pid)); setInterval(() => {}, 1000)']
    const pid = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const child = yield* Effect.forkScoped(implementCommand(input, command))
      const wait: Effect.Effect<number, Error> = Effect.tryPromise(() => readFile(join(directory, "child.pid"), "utf8")).pipe(Effect.map(Number), Effect.catch(() => Effect.sleep("10 millis").pipe(Effect.andThen(Effect.suspend(() => wait)))))
      const pid = yield* wait.pipe(Effect.timeout("5 seconds"))
      yield* Fiber.interrupt(child)
      return pid
    })))
    expect(() => process.kill(pid, 0)).toThrow()
  })().finally(() => rm(directory, { recursive: true, force: true }))
}, 10_000)
