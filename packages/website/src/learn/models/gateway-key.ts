// Where the page keeps the learner's AI Gateway key and the gateway model picked: in memory, and in this tab's
// sessionStorage so a reload of the tab keeps them. Never in localStorage (other tabs, and later visits, would read it),
// never in a cookie, an address or a trace. Closing the tab, or "Forget key", removes the key. The names are outside
// the lessons' own prefix (`efferent-learn:`), so a lesson's "Start over" and a script's cleanup leave them alone.
import { Option } from "effect"
import { DEFAULT_GATEWAY_MODEL } from "./gateway.ts"

const KEY_NAME = "efferent-gateway:key"
const MODEL_NAME = "efferent-gateway:model"

/** This tab's storage, or none where the browser gives none (a private window with storage blocked). */
const tabStorage = (): Storage | undefined => {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage
  } catch {
    return undefined
  }
}
const read = (name: string): Option.Option<string> => {
  try {
    return Option.fromNullishOr(tabStorage()?.getItem(name)).pipe(Option.filter((value) => value.length > 0))
  } catch {
    return Option.none()
  }
}
const write = (name: string, value: string | undefined) => {
  try {
    const storage = tabStorage()
    if (value === undefined) storage?.removeItem(name)
    else storage?.setItem(name, value)
  } catch {
    // The key is still held in memory for this page.
  }
}

let held: Option.Option<string> = Option.none()

/** The key the learner gave in this tab, if any. */
export const gatewayKey = (): Option.Option<string> => Option.orElse(held, () => read(KEY_NAME))

/** Keep `key` for this tab. Spaces around it, as a paste brings, are dropped; an empty key forgets. */
export const saveGatewayKey = (key: string) => {
  const trimmed = key.trim()
  held = trimmed.length > 0 ? Option.some(trimmed) : Option.none()
  write(KEY_NAME, trimmed.length > 0 ? trimmed : undefined)
}

/** Forget the key: from memory and from the tab's storage. */
export const forgetGatewayKey = () => {
  held = Option.none()
  write(KEY_NAME, undefined)
}

/** The gateway model picked in this tab, or the default. */
export const pickedGatewayModel = (): string => Option.getOrElse(read(MODEL_NAME), () => DEFAULT_GATEWAY_MODEL)
export const pickGatewayModel = (model: string) => write(MODEL_NAME, model)

/** The gateway's own list of models, read without a key: the language models that call tools, by id. */
export const listGatewayModels = async (fetchFn: (url: string) => Promise<Response> = (url) => fetch(url)): Promise<ReadonlyArray<string>> => {
  const response = await fetchFn("https://ai-gateway.vercel.sh/v1/models")
  if (!response.ok) throw new Error(`The gateway's list of models did not load (${response.status}).`)
  const body: unknown = await response.json()
  const data = typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data) ? body.data : []
  return data
    .filter((model: unknown) => typeof model === "object" && model !== null && "id" in model && typeof model.id === "string"
      && "type" in model && model.type === "language" && "tags" in model && Array.isArray(model.tags) && model.tags.includes("tool-use"))
    .map((model: { readonly id: string }) => model.id)
    .sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0))
}
