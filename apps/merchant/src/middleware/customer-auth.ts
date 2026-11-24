/**
 * Customer authentication middleware — re-exported from auth.ts.
 *
 * This file is kept for backwards compatibility with existing route imports.
 * The actual implementation lives in `middleware/auth.ts` and uses
 * Better Auth session cookies.
 */

export { customerAuthMiddleware } from './auth';
