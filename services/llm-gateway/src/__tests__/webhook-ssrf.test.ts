/**
 * The IPv4-mapped IPv6 cases specifically. `new URL()` rewrites the dotted quad
 * in `[::ffff:10.0.0.1]` as hextets (`[::ffff:a00:1]`), so a guard that only
 * matches the dotted spelling never fires for a parsed URL — which left
 * `https://[::ffff:169.254.169.254]/` reaching cloud metadata.
 */
import { describe, expect, it } from "vitest";

import { validateWebhookUrl } from "../lib/webhook-delivery.js";

describe("validateWebhookUrl — IPv4-mapped IPv6", () => {
    it.each([
        ["https://[::ffff:169.254.169.254]/", "cloud metadata"],
        ["https://[::ffff:10.0.0.1]/", "private 10/8"],
        ["https://[::ffff:127.0.0.1]/", "loopback"],
        ["https://[::ffff:192.168.1.1]/", "private 192.168/16"],
    ])("rejects %s (%s)", (url) => {
        expect(validateWebhookUrl(url)).not.toBeNull();
    });

    it("still allows a public mapped address", () => {
        expect(validateWebhookUrl("https://[::ffff:8.8.8.8]/")).toBeNull();
    });
});
