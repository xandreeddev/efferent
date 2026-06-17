import { Effect, Layer } from "effect"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { BlogReader, type BlogPost } from "../ports/BlogReader.js"

const BLOG_POSTS_DIR = "/home/user/Workspace/xandreed/blog/src/content/posts"

const parseFrontmatter = (rawContent: string): {
  readonly title: string
  readonly description: string
  readonly tags: ReadonlyArray<string>
  readonly body: string
} => {
  const match = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) {
    return { title: "", description: "", tags: [], body: rawContent }
  }
  
  const fmText = match[1] ?? ""
  const body = rawContent.slice(match[0]?.length ?? 0).trim()
  
  let title = ""
  let description = ""
  let tags: string[] = []
  
  for (const line of fmText.split("\n")) {
    const colonIndex = line.indexOf(":")
    if (colonIndex === -1) continue
    const key = line.slice(0, colonIndex).trim()
    const value = line.slice(colonIndex + 1).trim()
    
    if (key === "title") {
      title = value.replace(/^['"]|['"]$/g, "")
    } else if (key === "description") {
      description = value.replace(/^['"]|['"]$/g, "")
    } else if (key === "tags") {
      if (value.startsWith("[") && value.endsWith("]")) {
        tags = value
          .slice(1, -1)
          .split(",")
          .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
      }
    }
  }
  
  return { title, description, tags, body }
}

export const AstroBlogReaderLive = Layer.succeed(
  BlogReader,
  BlogReader.of({
    getPosts: () =>
      Effect.tryPromise({
        try: async () => {
          const files = await readdir(BLOG_POSTS_DIR)
          const mdFiles = files.filter((f) => f.endsWith(".md") && f !== "typography-test.md")
          const posts: BlogPost[] = []
          
          for (const file of mdFiles) {
            const filePath = join(BLOG_POSTS_DIR, file)
            const rawContent = await readFile(filePath, "utf-8")
            const slug = file.replace(/\.md$/, "")
            const { title, description, tags, body } = parseFrontmatter(rawContent)
            
            posts.push({
              slug,
              title,
              description,
              tags,
              content: body,
            })
          }
          return posts
        },
        catch: (e) => new Error(`Failed to read blog posts: ${String(e)}`),
      }),

    getPostContent: (slug: string) =>
      Effect.tryPromise({
        try: async () => {
          const filePath = join(BLOG_POSTS_DIR, `${slug}.md`)
          const rawContent = await readFile(filePath, "utf-8")
          const { body } = parseFrontmatter(rawContent)
          return body
        },
        catch: (e) => new Error(`Failed to read blog post "${slug}": ${String(e)}`),
      }),
  })
)
