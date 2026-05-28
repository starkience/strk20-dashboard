// Public API surface for @strk20/dashboard.

export { Dashboard } from "./Dashboard.js";
export { Strk20Provider, useStrk20 } from "./lib/provider.js";
export { Row } from "./lib/Row.js";

// Individual modules + their data hooks + types — cherry-pickable.
export {
  PoolOverview,
  usePoolOverviewData,
  type PoolOverviewProps,
  type PoolOverviewData,
  type PoolSummary,
  type ProtocolActivity,
  type ProtocolsResponse,
} from "./modules/PoolOverview.js";

export {
  AnonymitySet,
  useAnonymitySetData,
  type AnonymitySetProps,
  type AnonymitySetData,
} from "./modules/AnonymitySet.js";

export {
  PrivateOperations,
  usePrivateOperationsData,
  type PrivateOperationsProps,
  type PrivateOperationsData,
} from "./modules/PrivateOperations.js";

export {
  ActiveDepositors,
  useActiveDepositorsData,
  type ActiveDepositorsProps,
  type ActiveDepositorsData,
} from "./modules/ActiveDepositors.js";

export {
  NoteAgeHistogram,
  useNoteAgeHistogramData,
  type NoteAgeHistogramProps,
  type NoteAgeHistogramData,
} from "./modules/NoteAgeHistogram.js";

export {
  ShieldedTVL,
  useShieldedTVLData,
  type ShieldedTVLProps,
  type ShieldedTVLData,
  type ShieldedTVLToken,
} from "./modules/ShieldedTVL.js";

export { VisibilityTable } from "./modules/VisibilityTable.js";
