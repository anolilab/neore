import { TimeoutError } from "./timeout-error";

/**
 * A chat gateway call that hit the client deadline. The backend may already have saved the work, so the
 * message tells the user to check the conversation before retrying; a plain `TimeoutError` (a 408 from
 * another endpoint) gets the generic wording.
 */
export class GatewayDeadlineError extends TimeoutError {}
