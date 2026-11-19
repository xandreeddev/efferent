#!/usr/bin/env node
import { homedir } from "node:os"
import { reviewCli } from "./cli.adapter.js"
import { runMain } from "./run-main.adapter.js"

const env = Object.fromEntries(Object.entries(process.env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])))

runMain(reviewCli(process.argv.slice(2), { env, cwd: process.cwd(), home: homedir() }))
