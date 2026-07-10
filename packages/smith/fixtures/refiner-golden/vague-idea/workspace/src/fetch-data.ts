export const fetchData = async (url: string): Promise<unknown> => {
  // FIXME: swallows failures — callers can't tell a 404 from a network error
  const res = await fetch(url).catch(() => null)
  if (res === null) return null
  return res.json().catch(() => null)
}
