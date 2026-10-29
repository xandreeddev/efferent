import type { RetrievalContext, RetrievalItem, RetrievalMeasure } from "./semantic-retrieval.entity.js"

const itemsOf: { readonly [M in RetrievalMeasure]: (input: RetrievalContext) => ReadonlyArray<RetrievalItem> } = {
  "contextual-precision": (input) => input.documents.map((document) => ({ id: document.id, text: document.text })),
  "contextual-recall": (input) => input.expectedClaims.map((claim, index) => ({ id: `claim:${index}`, text: claim })),
  "contextual-relevancy": (input) => input.documents.flatMap((document) =>
    document.statements.map((statement, index) => ({ id: `${document.id}/statement:${index}`, text: statement }))),
}

/**
 * The units a measure's judge rules on, in order, each with the id its
 * verdict must carry: the documents (contextual precision, in rank order),
 * the expected claims (contextual recall) or every document's statements
 * (contextual relevancy). The judge returns exactly one verdict per id.
 */
export const retrievalItems = (measure: RetrievalMeasure, input: RetrievalContext): ReadonlyArray<RetrievalItem> => itemsOf[measure](input)
