// The embedder lesson 20's page loads, named and pinned: the name keys every vector, so the world's vectors made
// ahead are found under it. Kept apart from shipped.ts and models/meaning.ts, which every page would otherwise carry:
// both are loaded only when a button needs them.

/** The model the vectors are made with: the page's embedder, whose name keys them. */
export const EMBEDDER_MODEL = "Xenova/e5-small-v2"
/** The model's files, pinned: the page's worker loads this revision, and the shipped vectors were made with it. */
export const EMBEDDER_REVISION = "02af79985278377e65c724a76275707cb0333c70"
