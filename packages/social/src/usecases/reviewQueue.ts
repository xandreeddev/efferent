import { Effect } from "effect"
import { readdir, readFile, rename, unlink, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { spawn } from "node:child_process"
import * as readline from "node:readline"
import { XPlatform } from "../ports/XPlatform.js"

const PENDING_DIR = "/home/user/Workspace/xandreed/posts/drafts/pending"
const POSTED_DIR = "/home/user/Workspace/xandreed/posts/drafts/posted"
const DISCARDED_DIR = "/home/user/Workspace/xandreed/posts/drafts/discarded"

interface DraftMetadata {
  readonly type: "reply" | "post"
  readonly targetTweetId: string | null
  readonly targetAuthor: string | null
  readonly referenceBlogSlug: string | null
  readonly status: string
  readonly content: string
  readonly filePath: string
  readonly filename: string
}

const parseDraftFile = async (filename: string): Promise<DraftMetadata> => {
  const filePath = join(PENDING_DIR, filename)
  const fileContent = await readFile(filePath, "utf-8")
  
  const match = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const body = match ? fileContent.slice(match[0].length).trim() : fileContent.trim()
  
  let type: "reply" | "post" = "post"
  let targetTweetId: string | null = null
  let targetAuthor: string | null = null
  let referenceBlogSlug: string | null = null
  let status = "pending"

  if (match) {
    const fmText = match[1] ?? ""
    for (const line of fmText.split("\n")) {
      const colonIndex = line.indexOf(":")
      if (colonIndex === -1) continue
      const key = line.slice(0, colonIndex).trim()
      const value = line.slice(colonIndex + 1).trim().replace(/^['"]|['"]$/g, "")
      
      if (key === "type" && (value === "reply" || value === "post")) {
        type = value
      } else if (key === "targetTweetId" && value !== "null") {
        targetTweetId = value
      } else if (key === "targetAuthor" && value !== "null") {
        targetAuthor = value
      } else if (key === "referenceBlogSlug" && value !== "null") {
        referenceBlogSlug = value
      } else if (key === "status") {
        status = value
      }
    }
  }

  return {
    type,
    targetTweetId,
    targetAuthor,
    referenceBlogSlug,
    status,
    content: body,
    filePath,
    filename,
  }
}

const askQuestion = (query: string): Promise<string> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  return new Promise((resolve) =>
    rl.question(query, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  )
}

const openEditor = (filePath: string): Promise<void> => {
  const editor = process.env.EDITOR || "nano"
  return new Promise((resolve) => {
    const child = spawn(editor, [filePath], { stdio: "inherit" })
    child.on("exit", () => resolve())
  })
}

export const runReviewQueue = () =>
  Effect.gen(function* () {
    const x = yield* XPlatform
    
    yield* Effect.logInfo("Loading pending drafts...")
    const files = yield* Effect.tryPromise({
      try: async () => {
        try {
          return await readdir(PENDING_DIR)
        } catch {
          return []
        }
      },
      catch: (e) => new Error(`Failed to list pending drafts: ${String(e)}`),
    })

    const pendingDrafts = files.filter((f) => f.endsWith(".md"))

    if (pendingDrafts.length === 0) {
      console.log("\n🎉 No pending drafts in the review queue!")
      return
    }

    console.log(`\nFound ${pendingDrafts.length} drafts to review.\n`)

    for (const file of pendingDrafts) {
      let doneWithDraft = false
      
      while (!doneWithDraft) {
        const draft = yield* Effect.tryPromise({
          try: () => parseDraftFile(file),
          catch: (e) => new Error(`Failed to parse draft "${file}": ${String(e)}`),
        })

        console.log("==================================================")
        console.log(`DRAFT: ${draft.filename}`)
        console.log(`Type:  ${draft.type.toUpperCase()}`)
        if (draft.type === "reply") {
          console.log(`Replying to: ${draft.targetAuthor} (ID: ${draft.targetTweetId})`)
          console.log(`Target URL:  https://x.com/anyuser/status/${draft.targetTweetId}`)
        }
        if (draft.referenceBlogSlug) {
          console.log(`Ref Blog:    https://xandreed.dev/posts/${draft.referenceBlogSlug}`)
        }
        console.log("--------------------------------------------------")
        console.log(draft.content)
        console.log("==================================================")

        const choice = yield* Effect.promise(() =>
          askQuestion("[a] Approve & Post, [e] Edit, [d] Discard, [s] Skip, [q] Quit: ")
        )

        if (choice === "q") {
          console.log("Exiting review queue.")
          return
        }

        if (choice === "s") {
          console.log("Skipping draft.\n")
          doneWithDraft = true
          continue
        }

        if (choice === "d") {
          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(DISCARDED_DIR, { recursive: true })
              await rename(draft.filePath, join(DISCARDED_DIR, draft.filename))
            },
            catch: (e) => new Error(`Failed to discard draft: ${String(e)}`),
          })
          console.log("Draft moved to discarded.\n")
          doneWithDraft = true
          continue
        }

        if (choice === "e") {
          console.log(`Opening editor (${process.env.EDITOR || "nano"})...`)
          yield* Effect.promise(() => openEditor(draft.filePath))
          console.log("Reloading updated draft...\n")
          continue
        }

        if (choice === "a") {
          console.log("Posting to X...")
          yield* x.postTweet(draft.content, draft.targetTweetId ?? undefined).pipe(
            Effect.tap(() =>
              Effect.tryPromise({
                try: async () => {
                  await mkdir(POSTED_DIR, { recursive: true })
                  await rename(draft.filePath, join(POSTED_DIR, draft.filename))
                },
                catch: (e) => new Error(`Failed to archive posted draft: ${String(e)}`),
              })
            ),
            Effect.tap(() => Effect.sync(() => console.log("✅ Successfully posted to X!\n"))),
            Effect.catchAll((err) =>
              Effect.sync(() => console.error(`❌ Posting failed: ${err.message}\n`))
            )
          )
          doneWithDraft = true
        }
      }
    }

    console.log("Finished reviewing all pending drafts.")
  })
