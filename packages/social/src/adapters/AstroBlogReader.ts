import { Effect, Layer } from "effect"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { BlogReader, type BlogPost } from "../ports/BlogReader.js"

const BLOG_POSTS_DIR = "/home/asiborro/Workspace/xandreed/blog/src/content/posts"

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

  const folded = fmText.split("\n").reduce<{
    title: string
    description: string
    tags: ReadonlyArray<string>
  }>(
    (acc, line) => {
      const colonIndex = line.indexOf(":")
      if (colonIndex === -1) return acc
      const key = line.slice(0, colonIndex).trim()
      const value = line.slice(colonIndex + 1).trim()
      if (key === "title") return { ...acc, title: value.replace(/^['"]|['"]$/g, "") }
      if (key === "description") {
        return { ...acc, description: value.replace(/^['"]|['"]$/g, "") }
      }
      if (key === "tags" && value.startsWith("[") && value.endsWith("]")) {
        return {
          ...acc,
          tags: value
            .slice(1, -1)
            .split(",")
            .map((t) => t.trim().replace(/^['"]|['"]$/g, "")),
        }
      }
      return acc
    },
    { title: "", description: "", tags: [] },
  )

  return { ...folded, body }
}

export const AstroBlogReaderLive = Layer.succeed(
  BlogReader,
  BlogReader.of({
    getPosts: () =>
      Effect.tryPromise({
        try: async () => {
          const files = await readdir(BLOG_POSTS_DIR)
          const mdFiles = files.filter((f) => f.endsWith(".md") && f !== "typography-test.md")
          const posts: ReadonlyArray<BlogPost> = await Promise.all(
            mdFiles.map(async (file) => {
              const rawContent = await readFile(join(BLOG_POSTS_DIR, file), "utf-8")
              const { title, description, tags, body } = parseFrontmatter(rawContent)
              return {
                slug: file.replace(/\.md$/, ""),
                title,
                description,
                tags,
                content: body,
              }
            }),
          )
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
