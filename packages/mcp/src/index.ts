/**
 * The library surface. The package's product is the `rfphub-mcp` executable; these exports exist
 * so the pieces can be tested, and so a host that wants to mount the same tools on a transport
 * this package does not ship can do it without forking.
 */
export {
  createServer,
  toToolError,
  PROTOCOL_VERSION,
  SERVER_NAME,
  SERVER_VERSION,
} from "./server.js";
export {
  loadConfig,
  canonicalOrigin,
  keyFingerprint,
  ConfigError,
  DEFAULT_API_BASE,
  type McpConfig,
} from "./config.js";
export {
  ApiClient,
  MAX_RESPONSE_BYTES,
  ResponseTooLargeError,
  isSubmissionResult,
  readCapped,
  retryAfterMs,
  type Paginated,
  type OpportunitySummary,
  type SubmissionResult,
  type DuplicateMatch,
} from "./http.js";
export {
  ERROR_CODES,
  ToolError,
  apiErrorToToolError,
  ambiguousWriteError,
  mergedInto,
  type ErrorCode,
} from "./errors.js";
export {
  Policy,
  DEFAULT_CAPS,
  counterPath,
  counterLockPath,
  type ToolKind,
  type Caps,
  type Reservation,
} from "./policy.js";
export { withLock, LockTimeoutError, STALE_LOCK_MS, LOCK_TIMEOUT_MS } from "./lock.js";
export { RedactingTransport } from "./transport.js";
export { redact, redactString, findSecretPaths, registerSecret, REDACTED } from "./redact.js";
export { appendAudit, auditPath, summarizeInput, type AuditEntry } from "./audit.js";
export { canonicalStringify, digestOf, sha256Hex } from "./canonical.js";
export {
  computeApprovalId,
  documentHashOf,
  fingerprintOf,
  claimApproval,
  diagnoseMismatch,
  describeBinding,
  PENDING_TTL_MS,
  APPROVAL_TTL_MS,
  type ApprovalBinding,
  type ApprovalRecord,
  type PendingRecord,
} from "./approvals.js";
export { FUNDING_TYPES, STATUSES, SORT_FIELDS, SORT_ORDERS } from "./enums.js";
export { SEARCH_NOTICE, FETCH_NOTICE, delimit, truncate } from "./untrusted.js";
