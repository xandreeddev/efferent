import { Effect, Layer } from "effect"
import { chromium, type BrowserContext, type Page } from "playwright"
import { XPlatform, type XNotification, type XSearchResult } from "../ports/XPlatform.js"

const PROFILE_DIR = "/home/asiborro/Workspace/xandreed/.playwright-profile"

/**
 * Creates and manages a scoped persistent Playwright browser context.
 * This guarantees the browser is closed even if the calling Effect is interrupted.
 */
const runInBrowser = <A, E, R>(
  headless: boolean,
  action: (page: Page) => Effect.Effect<A, E, R>
): Effect.Effect<A, E | Error, R> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        chromium.launchPersistentContext(PROFILE_DIR, {
          headless,
          viewport: { width: 1280, height: 800 },
        }),
      catch: (e) => new Error(`Failed to launch browser: ${String(e)}`),
    }),
    (context) =>
      Effect.gen(function* () {
        const page = yield* Effect.tryPromise({
          try: () => context.newPage(),
          catch: (e) => new Error(`Failed to open page: ${String(e)}`),
        })
        return yield* action(page)
      }),
    (context) =>
      Effect.tryPromise({
        try: () => context.close(),
        catch: () => Promise.resolve(),
      }).pipe(Effect.orDie) // Ensure finalizer doesn't fail the effect
  )

export const PlaywrightXPlatformLive = Layer.succeed(
  XPlatform,
  XPlatform.of({
    search: (query: string) =>
      runInBrowser(true, (page) =>
        Effect.gen(function* () {
          yield* Effect.logInfo(`Searching X for: "${query}"`)
          const url = `https://x.com/search?q=${encodeURIComponent(query)}&f=live`
          
          yield* Effect.tryPromise({
            try: () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }),
            catch: (e) => new Error(`Failed to navigate to search: ${String(e)}`),
          })

          // Wait for tweets to appear
          yield* Effect.tryPromise({
            try: () => page.waitForSelector('[data-testid="tweet"]', { timeout: 15000 }),
            catch: (e) => new Error(`Tweets did not load: ${String(e)}`),
          })

          // Parse the loaded tweets
          const tweets = yield* Effect.tryPromise({
            try: async () => {
              const tweetElements = await page.locator('[data-testid="tweet"]').all()
              const parsed = await Promise.all(
                tweetElements.map(async (tweet, index) => {
                  const text = await tweet.locator('[data-testid="tweetText"]').first().innerText().catch(() => "")
                  const author = await tweet.locator('[data-testid="User-Name"]').first().innerText().catch(() => "")
                  const handleMatch = author.match(/@\w+/)
                  const timestamp = await tweet.locator("time").first().getAttribute("datetime").catch(() => "")
                  const href = await tweet.locator('a[href*="/status/"]').first().getAttribute("href").catch(() => "")
                  const idMatch = href ? href.match(/\/status\/(\d+)/) : null
                  return {
                    id: idMatch?.[1] ?? `temp_${index}`,
                    author: handleMatch ? handleMatch[0] : "unknown",
                    text,
                    timestamp: timestamp ?? new Date().toISOString(),
                  } satisfies XSearchResult
                }),
              )
              return parsed.filter((t) => t.text.trim().length > 0)
            },
            catch: (e) => new Error(`Failed to parse tweets: ${String(e)}`),
          })

          yield* Effect.logInfo(`Found ${tweets.length} tweets on X`)
          return tweets
        })
      ),

    getNotifications: () =>
      runInBrowser(true, (page) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("Fetching X notifications")
          yield* Effect.tryPromise({
            try: () => page.goto("https://x.com/notifications", { waitUntil: "domcontentloaded", timeout: 30000 }),
            catch: (e) => new Error(`Failed to navigate to notifications: ${String(e)}`),
          })

          // Wait for notifications to load
          yield* Effect.tryPromise({
            try: () => page.waitForSelector('[data-testid="cellInnerDiv"]', { timeout: 15000 }),
            catch: (e) => new Error(`Notifications did not load: ${String(e)}`),
          })

          const notifications = yield* Effect.tryPromise({
            try: async () => {
              const cellElements = await page.locator('[data-testid="cellInnerDiv"]').all()
              const parsed = await Promise.all(
                cellElements.map(async (cell) => {
                  const text = await cell.innerText().catch(() => "")
                  const href = await cell.locator('a[href*="/status/"]').first().getAttribute("href").catch(() => "")
                  const idMatch = href ? href.match(/\/status\/(\d+)/) : null
                  const handleMatch = text.match(/@\w+/)
                  return idMatch?.[1] !== undefined && text.trim().length > 0
                    ? [{
                        id: idMatch[1],
                        author: handleMatch ? handleMatch[0] : "unknown",
                        text: text.replace(/\n/g, " "),
                      } satisfies XNotification]
                    : []
                }),
              )
              return parsed.flat()
            },
            catch: (e) => new Error(`Failed to parse notifications: ${String(e)}`),
          })

          yield* Effect.logInfo(`Found ${notifications.length} notifications on X`)
          return notifications
        })
      ),

    readThread: (tweetId: string) =>
      runInBrowser(true, (page) =>
        Effect.gen(function* () {
          yield* Effect.logInfo(`Reading thread for tweet ${tweetId}`)
          const url = `https://x.com/anyuser/status/${tweetId}`
          yield* Effect.tryPromise({
            try: () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }),
            catch: (e) => new Error(`Failed to open the thread: ${String(e)}`),
          })
          yield* Effect.tryPromise({
            try: () => page.waitForSelector('[data-testid="tweet"]', { timeout: 15000 }),
            catch: (e) => new Error(`Thread did not load: ${String(e)}`),
          })
          const tweets = yield* Effect.tryPromise({
            try: async () => {
              const tweetElements = await page.locator('[data-testid="tweet"]').all()
              const parsed = await Promise.all(
                tweetElements.map(async (tweet, index) => {
                  const text = await tweet.locator('[data-testid="tweetText"]').first().innerText().catch(() => "")
                  const author = await tweet.locator('[data-testid="User-Name"]').first().innerText().catch(() => "")
                  const handleMatch = author.match(/@\w+/)
                  const timestamp = await tweet.locator("time").first().getAttribute("datetime").catch(() => "")
                  const href = await tweet.locator('a[href*="/status/"]').first().getAttribute("href").catch(() => "")
                  const idMatch = href ? href.match(/\/status\/(\d+)/) : null
                  // The FOCAL tweet's own permalink is the page URL, not a link —
                  // fall back to the requested id for the first element.
                  const id = idMatch?.[1] ?? (index === 0 ? tweetId : "")
                  return { id, author: handleMatch ? handleMatch[0] : "unknown", text, timestamp: timestamp ?? new Date().toISOString() }
                }),
              )
              return parsed.filter((t) => t.text.trim().length > 0 && t.id !== "")
            },
            catch: (e) => new Error(`Failed to parse the thread: ${String(e)}`),
          })
          yield* Effect.logInfo(`Read ${tweets.length} tweets from the thread`)
          return tweets
        })
      ),

    postTweet: (text: string, inReplyToId?: string) =>
      // Let it run in non-headless mode (false) if wanted, or headless.
      // Usually posting is fast, let's keep it headless: true.
      runInBrowser(true, (page) =>
        Effect.gen(function* () {
          if (inReplyToId) {
            yield* Effect.logInfo(`Replying to tweet ID ${inReplyToId} on X`)
            const replyUrl = `https://x.com/anyuser/status/${inReplyToId}`
            yield* Effect.tryPromise({
              try: () => page.goto(replyUrl, { waitUntil: "domcontentloaded", timeout: 30000 }),
              catch: (e) => new Error(`Failed to load target tweet page: ${String(e)}`),
            })

            // Click reply container
            yield* Effect.tryPromise({
              try: () => page.click('[data-testid="tweetReplyTextBox_EDITOR"]', { timeout: 10000 }),
              catch: (e) => new Error(`Failed to locate reply text area: ${String(e)}`),
            })

            // Fill text
            yield* Effect.tryPromise({
              try: () => page.fill('[data-testid="tweetReplyTextBox_EDITOR"]', text),
              catch: (e) => new Error(`Failed to fill reply text: ${String(e)}`),
            })

            // Click Reply button
            yield* Effect.tryPromise({
              try: () => page.click('[data-testid="tweetButtonInline"]'),
              catch: (e) => new Error(`Failed to click reply button: ${String(e)}`),
            })
          } else {
            yield* Effect.logInfo("Posting new tweet on X")
            yield* Effect.tryPromise({
              try: () => page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded", timeout: 30000 }),
              catch: (e) => new Error(`Failed to navigate to tweet composer: ${String(e)}`),
            })

            // Wait for composer to load and focus
            yield* Effect.tryPromise({
              try: () => page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 15000 }),
              catch: (e) => new Error(`Tweet composer did not load: ${String(e)}`),
            })

            // Fill text
            yield* Effect.tryPromise({
              try: () => page.fill('[data-testid="tweetTextarea_0"]', text),
              catch: (e) => new Error(`Failed to fill tweet composer: ${String(e)}`),
            })

            // Click Tweet button
            yield* Effect.tryPromise({
              try: () => page.click('[data-testid="tweetButton"]'),
              catch: (e) => new Error(`Failed to click post tweet button: ${String(e)}`),
            })
          }

          // Wait 3 seconds to ensure POST is processed
          yield* Effect.promise(() => page.waitForTimeout(3000))
          yield* Effect.logInfo("Tweet published successfully")
        })
      ),
  })
)
