// Every lesson the workbench can run, by its page slug.
import { Option } from "effect"
import type { Lesson } from "../lesson.ts"
import { tools } from "./tools/lesson.ts"
import { yourFirstAgent } from "./your-first-agent/lesson.ts"

const lessons: ReadonlyArray<Lesson> = [yourFirstAgent, tools]

export const lessonOf = (slug: string): Option.Option<Lesson> => Option.fromNullishOr(lessons.find((lesson) => lesson.slug === slug))
