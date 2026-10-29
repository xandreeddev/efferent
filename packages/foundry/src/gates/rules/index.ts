import { brandedIdFields } from "./brandedIdFields.js"
import { matchOverTagSwitch } from "./matchOverTagSwitch.js"
import { noAsAny } from "./noAsAny.js"
import { noEmptyCatch } from "./noEmptyCatch.js"
import { noLet } from "./noLet.js"
import { noLoopStatements } from "./noLoopStatements.js"
import { noNullableReturn } from "./noNullableReturn.js"
import { noParallelInterface } from "./noParallelInterface.js"
import { noSkippedTests } from "./noSkippedTests.js"
import { noTryCatch } from "./noTryCatch.js"
import { noAmbientTimeRandom, noProcessEnv } from "./ambientServices.js"
import { noJsonParse, noSyncCodec } from "./boundaryDecoding.js"
import { callbackBufferSize } from "./callbackBufferSize.js"
import { noLocaleCompare, requireSortComparator } from "./deterministicOrder.js"
import { noCausePrettyData, noInstanceofTaggedError } from "./errorValues.js"
import { noEffectPromise, noPromiseAll } from "./promiseInterop.js"
import {
  contextTagsLiveInPorts,
  contractsContainNoBehavior,
  effectArchitectureRules,
  layersLiveAtEdges,
  noRawPromiseCore,
  noRuntimeImportsCore,
} from "./effectArchitecture.js"

/** The shipped rules are a LIBRARY organized as packs (`packs.js`) — config
 *  resolution never falls back to them implicitly; a config module names
 *  what it wants via its `rulePacks`/`customRules` exports. */
export * from "./custom.js"
export * from "./packs.js"

export {
  brandedIdFields,
  matchOverTagSwitch,
  noAsAny,
  noEmptyCatch,
  noLet,
  noLoopStatements,
  noNullableReturn,
  noParallelInterface,
  noSkippedTests,
  noTryCatch,
  noJsonParse,
  noSyncCodec,
  noCausePrettyData,
  noEffectPromise,
  noPromiseAll,
  callbackBufferSize,
  noProcessEnv,
  noAmbientTimeRandom,
  noLocaleCompare,
  requireSortComparator,
  noInstanceofTaggedError,
  contextTagsLiveInPorts,
  contractsContainNoBehavior,
  effectArchitectureRules,
  layersLiveAtEdges,
  noRawPromiseCore,
  noRuntimeImportsCore,
}
