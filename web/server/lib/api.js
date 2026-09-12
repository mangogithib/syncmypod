// Small helpers shared by every route file.

// Wraps an async handler so a rejected promise reaches Express's error handler
// instead of becoming an unhandled rejection and a request that hangs forever.
// Express 4 does not do this itself; Express 5 will, at which point this can go.
export const handler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// A deliberate, reportable failure - a bad request, a missing row - as opposed
// to a bug. The error handler turns these into their status and message, and
// anything else into a 500 with the detail kept in the logs.
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const notFound = (message = 'Not found.') => new HttpError(404, message);
export const conflict = (message) => new HttpError(409, message);

// ---------------------------------------------------------------------------
// Input coercion
// ---------------------------------------------------------------------------
//
// Everything from a request body is untrusted and untyped. These turn it into
// something usable or throw a message a user can act on.

export function str(value, field, { required = false, max = 500, min = 0 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw badRequest(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw badRequest(`${field} must be at least ${min} characters.`);
  }
  if (trimmed.length > max) {
    throw badRequest(`${field} must be ${max} characters or fewer.`);
  }
  return trimmed;
}

export function num(value, field, { required = false, min, max } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${field} must be a number.`);
  if (min !== undefined && parsed < min) {
    throw badRequest(`${field} must be at least ${min}.`);
  }
  if (max !== undefined && parsed > max) {
    throw badRequest(`${field} must be at most ${max}.`);
  }
  return parsed;
}

export function id(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw badRequest(`${field} is not a valid id.`);
  }
  return parsed;
}

export function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return value === 'true' || value === '1' || value === 1;
}

// Offset pagination, capped so a stray ?limit=100000 cannot be used to pull the
// whole catalogue in one request.
export function pagination(query, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const limit = Math.min(
    Math.max(Number(query.limit) || defaultLimit, 1),
    maxLimit
  );
  const offset = Math.max(Number(query.offset) || 0, 0);
  return { limit, offset };
}
