#!/usr/bin/env node
import { Effect } from "effect"
import { evaluationCli } from "./cli.adapter.js"

await Effect.runPromise(evaluationCli(process.argv.slice(2)).pipe(Effect.match({ onSuccess: (code) => { process.exitCode = code }, onFailure: (error) => { console.error(`${error.code}: ${error.message}`); process.exitCode = 1 } })))
