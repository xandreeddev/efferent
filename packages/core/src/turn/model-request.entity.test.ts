import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { Tool } from "effect/ai"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import { modelRequestTools } from "./model-request.entity.functions.js"

/** A provider-defined tool whose configuration carries a credential, as a remote tool server's does. */
const RemoteTools = Tool.providerDefined({
  id: "test.remote_tools",
  customName: "RemoteTools",
  providerName: "remote_tools",
  args: Schema.Struct({ server_label: Schema.String, server_url: Schema.String, authorization: Schema.String }),
})
const LongNote = Tool.providerDefined({
  id: "test.long_note",
  customName: "LongNote",
  providerName: "long_note",
  args: Schema.Struct({ note: Schema.String }),
})

const configured = { server_label: "crm", server_url: "https://tools.example/sse", authorization: "oauth-secret-token" }

describe("a request header's provider-defined tools", () => {
  test("keep the args' key names and digest, never their values", () => {
    const [declared] = modelRequestTools([RemoteTools(configured)])
    const stored = canonicalJson(declared)
    expect(stored).not.toContain("oauth-secret-token")
    expect(stored).not.toContain("https://tools.example/sse")
    expect(declared?.provider).toEqual(Option.some({
      id: "test.remote_tools", name: "remote_tools",
      argKeys: ["authorization", "server_label", "server_url"],
      // SHA-256 of the args' canonical JSON.
      argsDigest: "a3a6ded6b95854abe00164b8bad45f8c10fbb548aa126eea37a736655b226630",
    }))
  })

  test("a change of any value changes the digest the dispatch check compares", () => {
    const [before] = modelRequestTools([RemoteTools(configured)])
    const [after] = modelRequestTools([RemoteTools({ ...configured, authorization: "rotated-token" })])
    expect(canonicalJson(before)).not.toBe(canonicalJson(after))
    expect(canonicalJson(modelRequestTools([RemoteTools({ ...configured })]))).toBe(canonicalJson([before]))
  })

  test("the digest is SHA-256 over the UTF-8 bytes, across several blocks", () => {
    const [declared] = modelRequestTools([LongNote({ note: `${"é∑".repeat(40)}${"x".repeat(70)}` })])
    expect(canonicalJson(declared)).toContain("c37e6fcebf600ea7ab5009666aba1c1d3d3efdef0f7723219715a06299be50f6")
  })
})
