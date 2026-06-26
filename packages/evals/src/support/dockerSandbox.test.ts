import { expect, test } from "bun:test"
import { sandboxRunArgs } from "./dockerSandbox.js"

/** The sandbox must carry network + resource isolation so untrusted, LLM-generated
 *  code can't reach the network or exhaust the host. Pure args → no Docker needed. */
test("sandbox run args carry network isolation + resource caps", () => {
  const args = sandboxRunArgs("/tmp/case-xyz", 1000, 1000)
  const joined = args.join(" ")
  expect(joined).toContain("--network none")
  expect(joined).toContain("--memory 2g")
  expect(joined).toContain("--memory-swap 2g") // == memory ⇒ swap disabled
  expect(joined).toContain("--pids-limit 512")
  expect(joined).toContain("--cpus 2")
  expect(joined).toContain("--user 1000:1000")
  expect(joined).toContain("/tmp/case-xyz:/work")
  expect(args).toContain("--rm") // ephemeral
  expect(args).toContain("-d") // detached
})
