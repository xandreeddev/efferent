import { Context, Effect } from "effect"

export interface BlogPost {
  readonly slug: string
  readonly title: string
  readonly description: string
  readonly tags: ReadonlyArray<string>
  readonly content: string
}

export class BlogReader extends Context.Tag("BlogReader")<
  BlogReader,
  {
    readonly getPosts: () => Effect.Effect<ReadonlyArray<BlogPost>, Error>
    readonly getPostContent: (slug: string) => Effect.Effect<string, Error>
  }
>() {}
