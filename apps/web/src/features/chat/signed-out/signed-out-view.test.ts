import { describe, expect, it } from "vitest";

import { signedOutViewFor } from "./signed-out-view";

describe("signedOutViewFor", () => {
    it.each([
        ["/chat", "chat"],
        ["/chat/", "chat"],
        ["/chat/0f8b2c1e-1234", "chat"],
        ["/workflow/shared/abc123", "page"],
        ["/workflow", "sign-in"],
        ["/workflow/gallery", "sign-in"],
        ["/workflow/wf-1", "sign-in"],
        ["/chat/thread/extra", "sign-in"],
    ] as const)("%s → %s", (pathname, view) => {
        expect(signedOutViewFor(pathname)).toBe(view);
    });
});
