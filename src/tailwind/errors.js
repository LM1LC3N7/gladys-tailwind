// -----------------------------------------------------------------------------
// The failures of a request to a controller, by kind. Messages are our own
// words only: never an address, a header (the TOKEN header carries the local
// control key) nor a body.
// -----------------------------------------------------------------------------

/**
 * - timeout:     no complete answer in time
 * - unreachable: no connection, or a connection lost
 * - late:        a command could not leave before its deadline (nothing sent)
 * - cancelled:   cancelled before its connection was up (nothing sent)
 * - busy:        HTTP 429 or 5xx, the controller asks for a pause
 * - http:        another HTTP status
 * - invalid:     not the JSON a Tailwind controller answers
 * - tooLarge:    the answer exceeds the size cap
 * - token:       the controller refused the local control key ("token fail")
 * - fail:        the controller answered "Fail" (it refused the request)
 */
export class TailwindError extends Error {
  constructor(kind, { status, sent = false, retryAfter } = {}) {
    super(status ? `${kind} (HTTP ${status})` : kind);
    this.name = 'TailwindError';
    this.kind = kind;
    this.status = status;
    this.sent = sent;
    this.retryAfter = retryAfter;
  }
}

/** A short reason for the logs and the user: the kind, and the status if any. */
export const reasonOf = (err) => (err instanceof TailwindError ? err.message : 'unexpected error');
