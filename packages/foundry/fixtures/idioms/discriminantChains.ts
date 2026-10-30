type Shape = { readonly _tag: "circle" } | { readonly _tag: "square" } | { readonly _tag: "line" }
type Message = { readonly role: "user" | "assistant" | "tool"; readonly mode: "plan" | "act" }

export const name = (shape: Shape): string =>
  shape._tag === "circle" ? "round" : shape._tag === "square" ? "boxy" : "flat"
export const speaker = (message: Message): string =>
  message.role === "user" ? "you" : (message.role === "assistant" ? "me" : "a tool")
export const rank = (message: Message): number => {
  switch (message.mode) {
    case "plan": return 1
    default: return 0
  }
}
export const one = (shape: Shape): string => (shape._tag === "circle" ? "round" : "other")
export const same = (a: Message, b: Message): string => (a.mode === b.mode ? "same" : a.role === "user" ? "you" : "them")
export const outline = (shape: Shape): string => {
  if (shape._tag === "circle") return "round"
  if (shape._tag === "square") {
    return "boxy"
  }
  return "flat"
}
export const edge = (shape: Shape): string => {
  if (shape._tag === "circle") return "round"
  if (shape._tag === "line") {
    return "thin"
  } else {
    return "boxy"
  }
}
export const turn = (a: Message, b: Message): string => {
  if (a.role === "user") return "you"
  if (b.role === "user") return "them"
  return "nobody"
}
