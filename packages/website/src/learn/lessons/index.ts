// Every lesson the workbench can run, by its page slug.
import { Option } from "effect"
import type { Lesson } from "../lesson.ts"
import { subAgents } from "./sub-agents/lesson.ts"
import { tools } from "./tools/lesson.ts"
import { yourOwnPlugin } from "./your-own-plugin/lesson.ts"
import { yourFirstAgent } from "./your-first-agent/lesson.ts"

const lessons: ReadonlyArray<Lesson> = [yourFirstAgent, tools, yourOwnPlugin, subAgents]

export const lessonOf = (slug: string): Option.Option<Lesson> => Option.fromNullishOr(lessons.find((lesson) => lesson.slug === slug))
