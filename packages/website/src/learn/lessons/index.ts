// Every lesson the workbench can run, by its page slug.
import { Option } from "effect"
import type { Lesson } from "../lesson.ts"
import { approvals } from "./approvals/lesson.ts"
import { compaction } from "./compaction/lesson.ts"
import { keepTheConversation } from "./keep-the-conversation/lesson.ts"
import { modelFailures } from "./model-failures/lesson.ts"
import { pointers } from "./pointers/lesson.ts"
import { remember } from "./remember/lesson.ts"
import { render } from "./render/lesson.ts"
import { skillsLesson } from "./skills/lesson.ts"
import { subAgents } from "./sub-agents/lesson.ts"
import { testYourAgent } from "./test-your-agent/lesson.ts"
import { tools } from "./tools/lesson.ts"
import { yourOwnPlugin } from "./your-own-plugin/lesson.ts"
import { yourFirstAgent } from "./your-first-agent/lesson.ts"

const lessons: ReadonlyArray<Lesson> = [yourFirstAgent, tools, yourOwnPlugin, subAgents, compaction, render, keepTheConversation, pointers, approvals, skillsLesson, remember, testYourAgent, modelFailures]

/** Every lesson's slug, in the order of the track. */
export const lessonSlugs: ReadonlyArray<string> = lessons.map((lesson) => lesson.slug)

export const lessonOf = (slug: string): Option.Option<Lesson> => Option.fromNullishOr(lessons.find((lesson) => lesson.slug === slug))
