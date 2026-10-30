// Legal: the root, an exported subpath and a pattern export of a package
// whose layer canImport names, and a relative import inside the package.
import { base } from "@fixture/base"
import { check } from "@fixture/base/kits/check"
import { shared } from "@fixture/base/public"
import { local } from "./local.js"

export const app = [base, check, shared, local]
