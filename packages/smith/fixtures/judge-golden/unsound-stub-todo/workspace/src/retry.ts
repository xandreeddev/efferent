// TODO: implement the retry loop (backoff, attempt counting)
export const withRetry = async <T>(fn: () => Promise<T>, _attempts: number): Promise<T> =>
  fn()
