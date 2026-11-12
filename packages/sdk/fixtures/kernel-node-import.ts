/*
 * The control of the kernel's browser-bundle test: the kernel's entry and
 * one runtime module beside it. A bundle check that passes on this file
 * checks nothing.
 */
import { sep } from "node:path"
import { Agent } from "../src/kernel/index.js"

export const control = { Agent, sep }
