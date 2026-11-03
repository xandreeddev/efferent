#!/usr/bin/env bun
/** Dry-run packing by default; live publication is restricted to the validated CI source. */
import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { Result, Schema } from "effect"
import { ciAuthentication, registry } from "./publish-plan.js"
import { decodeLandingJson, landingArguments, landingCommand, landingSource, landingVersion, packNpmLanding } from "./npm-landing.js"
import type { LandingCommand, LandingPack } from "./npm-landing.js"

const Metadata = Schema.Struct({ name: Schema.String, version: Schema.String, gitHead: Schema.optionalKey(Schema.String), dist: Schema.optionalKey(Schema.Struct({ integrity: Schema.optionalKey(Schema.String) })) })
type Metadata = typeof Metadata.Type
export interface LandingPublishOptions { readonly root: string; readonly live: boolean; readonly ci: boolean }
export interface LandingPublishDependencies {
  readonly run?: LandingCommand
  readonly env?: NodeJS.ProcessEnv
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>
  readonly sleep?: (milliseconds: number) => Promise<unknown>
  readonly confirmation?: { readonly attempts: number; readonly intervalMs: number }
}
const exactLanding = (metadata: Metadata, pack: LandingPack) => metadata.name === "efferent" && metadata.version === pack.version && metadata.gitHead === pack.sha && metadata.dist?.integrity === pack.integrity
const newerVersion = (left: string, right: string) => left.split(".").map(Number).some((part, index, parts) => part > Number(right.split(".")[index]) && parts.slice(0, index).every((before, at) => before === Number(right.split(".")[at])))
export const publishNpmLanding = async (options: LandingPublishOptions, dependencies: LandingPublishDependencies = {}) => {
  const env = dependencies.env ?? process.env
  const run = dependencies.run ?? landingCommand
  const fetcher = dependencies.fetch ?? globalThis.fetch
  const sleep = dependencies.sleep ?? Bun.sleep
  const schedule = dependencies.confirmation ?? { attempts: 12, intervalMs: 5000 }
  if (options.live && !options.ci) throw new Error("Live landing publication requires --ci --publish; local live publication is refused")
  if (options.live) {
    const authentication = ciAuthentication(env)
    if (Result.isFailure(authentication)) throw new Error(authentication.failure)
    if (authentication.success === "token") {
      const whoami = await run(["npm", "whoami", "--registry", registry], options.root, env)
      if (whoami.code !== 0 || whoami.stdout.trim() !== "xandreed") throw new Error("The npm landing token must belong to xandreed")
    }
  }
  const pack = await packNpmLanding(options.root, run, env)
  if (!options.live) return { ...pack, published: false, skipped: false }
  const metadataAt = async (name: string, version: string): Promise<Metadata | undefined> => {
    const response = await fetcher(`${registry}/${name.replace("/", "%2f")}/${version}?cb=${Date.now()}`, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(5000) })
    if (response.status === 404) return undefined
    if (response.status !== 200) throw new Error(`The npm registry answered ${response.status} for ${name}@${version}`)
    return decodeLandingJson(Metadata, await response.text())
  }
  const core = await metadataAt("@xandreed/core", pack.version)
  if (!core || core.name !== "@xandreed/core" || core.version !== pack.version || core.gitHead !== pack.sha) throw new Error("The published framework core must match the landing version and exact source commit")
  const existing = await metadataAt("efferent", pack.version)
  if (existing) {
    if (!exactLanding(existing, pack)) throw new Error("The existing landing version has different provenance or tarball integrity")
    return { ...pack, published: false, skipped: true }
  }
  const latest = await metadataAt("efferent", "latest")
  if (latest && (latest.name !== "efferent" || !landingVersion(latest.version) || newerVersion(latest.version, pack.version))) throw new Error("Refusing to move the efferent latest tag backwards or from unverifiable metadata")
  const current = await landingSource(options.root, run, env)
  if (current.sha !== pack.sha || current.version !== pack.version) throw new Error("The landing source changed after packing")
  const integrity = `sha512-${createHash("sha512").update(await readFile(pack.tarball)).digest("base64")}`
  if (integrity !== pack.integrity) throw new Error("The landing tarball changed after validation")
  // npm's signed workflow identity must remain authentic; the artifact's gitHead identifies its source separately.
  const uploaded = await run(["npm", "publish", pack.tarball, "--provenance", "--access", "public", "--tag", "latest", "--registry", registry, "--ignore-scripts"], pack.root, env)
  if (uploaded.code !== 0) console.error(`npm publish failed (exit ${uploaded.code}); checking whether the upload reached npm.\n${(uploaded.stderr.trim() || uploaded.stdout.trim()).slice(0, 8000)}`)
  const deadline = Date.now() + 60_000
  let last = uploaded.code === 0 ? "The uploaded version is not visible" : "npm publish failed and its upload could not be confirmed"
  for (let attempt = 0; attempt < schedule.attempts && Date.now() < deadline; attempt++) {
    if (attempt > 0) await sleep(Math.min(schedule.intervalMs, Math.max(0, deadline - Date.now())))
    try {
      const found = await metadataAt("efferent", pack.version)
      if (found) {
        if (!exactLanding(found, pack)) throw new Error("The confirmed landing version has different provenance or tarball integrity")
        return { ...pack, published: true, skipped: false }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("different provenance")) throw error
      last = error instanceof Error ? error.message : "The registry confirmation failed"
    }
  }
  throw new Error(`${last}; no exact landing publication was confirmed`)
}
if (import.meta.main) {
  try { console.log(JSON.stringify(await publishNpmLanding(landingArguments(process.argv.slice(2), true)), null, 2)) }
  catch (error) { console.error(error instanceof Error ? error.message : "Landing publication failed"); process.exit(1) }
}
