/** An error that maps to an HTTP response. Business errors (4xx) are stored with idempotency keys. */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
