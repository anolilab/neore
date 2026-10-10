import { LunoraError } from "lunorash/server";

import { ERROR_CODES, getErrorMessage } from "./error-codes";

/**
 * Throw an unauthorized error
 */

/**
 * These are declared as `const name: (…) => never = …` rather than
 * `const name = (…): never => …`.
 *
 * TypeScript only lets a `never`-returning CALL terminate a code path when the
 * callee is a name whose DECLARATION carries an explicit type annotation — an
 * inferred `const` does not qualify, the same restriction assertion functions
 * have. With the return type on the arrow instead of the const, every
 * `if (!row) { throwNotFound("…"); }` failed to narrow, and the next line read
 * `row.userId` off a possibly-null value. Three such ownership checks in
 * `workflow/functions.ts` alone.
 */
export const throwUnauthorized: (message?: string) => never = (message) => {
    throw new LunoraError("UNAUTHORIZED", message || getErrorMessage(ERROR_CODES.UNAUTHORIZED));
};

/**
 * Throw a not found error.
 */
export const throwNotFound: (resource: string) => never = (resource) => {
    throw new LunoraError("NOT_FOUND", `${resource} not found`);
};

/**
 * Throw a thread not found error.
 */
export const throwThreadNotFound: (message?: string) => never = (message) => {
    throw new LunoraError("NOT_FOUND", message || getErrorMessage(ERROR_CODES.THREAD_NOT_FOUND));
};

/**
 * Throw a forbidden error.
 */
export const throwForbidden: (message?: string) => never = (message) => {
    throw new LunoraError("FORBIDDEN", message || "You are not authorized to perform this action.");
};

/**
 * Throw a bad request error.
 */
export const throwBadRequest: (message: string) => never = (message) => {
    // The message used to be dropped — the port wrote `new LunoraError("BAD_REQUEST")`
    // with no second argument, and the codemod renamed the now-unused parameter to
    // `_message`, which silenced the warning instead of surfacing the loss. The
    // callers all pass a specific message and were all getting "BAD_REQUEST".
    throw new LunoraError("BAD_REQUEST", message);
};

/**
 * Throw an internal server error.
 */
export const throwInternalError: (message: string) => never = (message) => {
    throw new LunoraError("INTERNAL_SERVER_ERROR", message);
};

/**
 * Throw if `condition` is falsy, and narrow it for the rest of the scope.
 *
 * `LunoraError("INTERNAL")` rather than a plain `Error` so the message is
 * redacted at the wire boundary — assertions fire on broken invariants and their
 * text carries ids and internal state.
 */
export function assert(condition: unknown, message = "Assertion failed"): asserts condition {
    if (!condition) {
        throw new LunoraError("INTERNAL", message);
    }
}
