/**
 * guardrails.integration.test.ts
 *
 * PII masking and prompt-injection blocking are NOT implemented. These stay as
 * `todo` because they describe a real gap, not a missing test.
 *
 * Read alongside what DOES ship, so this is not mistaken for "the gateway does
 * no content filtering":
 *   - `middleware/content-safety.ts` — banned words, slurs and hate speech via
 *     `@visulima/content-safety`, on the `/internal/*` endpoints that take user
 *     text. That is a different control from either item below and is live.
 *   - `middleware/input-validation.ts` — request shape and media limits.
 *
 * So the gap is specifically: nothing masks PII before a prompt reaches a
 * provider, and nothing rejects prompt-injection patterns.
 */
import { describe, it } from "vitest";

describe("guardrails integration (unimplemented — PII masking, injection blocking)", () => {
    it.todo("masks PII (email addresses) in user messages before sending to LLM");

    it.todo("masks PII (phone numbers) in user messages before sending to LLM");

    it.todo("blocks prompt injection patterns and returns 400");

    it.todo("allows clean requests through without modification");

    it.todo("logs PII detection events to the audit trail");
});
