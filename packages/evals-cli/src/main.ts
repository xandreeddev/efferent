#!/usr/bin/env node
import { evaluationCli } from "./cli.adapter.js"
import { runCliMain } from "./run-main.adapter.js"

runCliMain(evaluationCli(process.argv.slice(2)))
