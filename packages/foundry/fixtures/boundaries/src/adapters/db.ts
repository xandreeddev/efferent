import * as path from "node:path"
import { nothing } from "../domain/entity.js"

export const db = path.join("store", nothing._tag)
