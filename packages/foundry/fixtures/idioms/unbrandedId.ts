import { Schema } from "effect"

export const Thing = Schema.Struct({
  id: Schema.String,
  userId: Schema.String.pipe(Schema.minLength(1)),
  goodId: Schema.String.pipe(Schema.brand("GoodId")),
  name: Schema.String,
})
