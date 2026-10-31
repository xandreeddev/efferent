/** Shipped request resolver and pure hashing, shared by the packed Node/Bun checks. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { requestHeaderConformance } from "@xandreed/core/conformance"
import { sha256Of } from "@xandreed/core/internal"

const checks = requestHeaderConformance()
assert.equal(checks.length, 5)
await Effect.runPromise(Effect.forEach(checks, (check) => check.run, { concurrency: 1 }))
const vectors = ["", "abc", "你好, 🌍", ...[55, 56, 63, 64, 65, 1000].map((size) => "a".repeat(size))]
vectors.forEach((text) => assert.equal(sha256Of(text), createHash("sha256").update(text, "utf8").digest("hex")))
console.log(`request-header ${JSON.stringify({ runtime: typeof Bun === "undefined" ? "Node" : "Bun", checks: checks.length, hashVectors: vectors.length, headerVerified: true })}`)
