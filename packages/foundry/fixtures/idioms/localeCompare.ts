import { Array as Arr, Order } from "effect"

export const byLocale = (words: ReadonlyArray<string>) => [...words].sort((a, b) => a.localeCompare(b))
export const byCodeUnit = (words: ReadonlyArray<string>) => Arr.sort(words, Order.String)
