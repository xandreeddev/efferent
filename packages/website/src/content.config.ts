import { defineCollection, z } from "astro:content"
import { glob } from "astro/loaders"

const docs = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    // tolerated from the old frontmatter; sidebar order/labels now live in nav.ts
    sidebar: z
      .object({ label: z.string().optional(), order: z.number().optional() })
      .optional(),
  }),
})

// Interactive lessons (the /learn track): one MDX file per lesson, ordered by its numeric prefix.
const lessons = defineCollection({
  loader: glob({ pattern: "*.mdx", base: "./src/content/learn" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    minutes: z.number(),
  }),
})

export const collections = { docs, lessons }
