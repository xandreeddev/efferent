import { Config } from "effect"

export const home = process.env["HOME"]
export const { PATH } = process.env
export const configured = Config.String("HOME")
// process.env in a comment is not code
