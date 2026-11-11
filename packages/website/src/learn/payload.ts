/** An event's payload as readable JSON for the event lists: long strings are cut, odd values never throw. */
export const payloadText = (value: unknown, maxString = 600): string => {
  const seen = new WeakSet<object>()
  const text = JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (typeof item === "bigint") return `${item}n`
      if (typeof item === "string" && item.length > maxString) return `${item.slice(0, maxString)}… (${item.length - maxString} more characters)`
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[circular]"
        seen.add(item)
      }
      return item
    },
    2,
  )
  return text ?? String(value)
}
