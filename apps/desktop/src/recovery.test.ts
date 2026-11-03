import { describe, expect, it } from "vitest";

import { recoveryPageHtml, recoveryPageUrl, RELEASES_URL, shouldRecoverFromLoadFailure, shouldRecoverFromRendererGone } from "./recovery.js";

describe("when the recovery page shows", () => {
    it("shows for a failed top-frame load, not for a cancelled one, a subframe or the page itself", () => {
        expect(shouldRecoverFromLoadFailure(-105, true, "https://neore.ai/chat")).toBe(true);
        expect(shouldRecoverFromLoadFailure(-3, true, "https://neore.ai/chat")).toBe(false);
        expect(shouldRecoverFromLoadFailure(-105, false, "https://neore.ai/chat")).toBe(false);
        expect(shouldRecoverFromLoadFailure(-2, true, "data:text/html,x")).toBe(false);
    });

    it("shows for every way the renderer went but a clean exit", () => {
        for (const reason of ["crashed", "oom", "killed", "launch-failed", "abnormal-exit"]) {
            expect(shouldRecoverFromRendererGone(reason), reason).toBe(true);
        }

        expect(shouldRecoverFromRendererGone("clean-exit")).toBe(false);
    });
});

describe("the recovery page", () => {
    it("offers a retry to the site and the last release, with no script", () => {
        const html = recoveryPageHtml("unreachable", "https://neore.ai/chat", "ERR_NAME_NOT_RESOLVED (-105)");

        expect(html).toContain("href=\"https://neore.ai/chat\"");
        expect(html).toContain(`href="${RELEASES_URL}"`);
        expect(html).toContain("ERR_NAME_NOT_RESOLVED");
        expect(html).not.toContain("<script");
        expect(html).toContain("default-src 'none'");
    });

    it("escapes the detail so a reason cannot add markup", () => {
        const html = recoveryPageHtml("crashed", "https://neore.ai/chat", "<img src=x onerror=\"1\">");

        expect(html).not.toContain("<img");
        expect(html).toContain("&lt;img");
    });

    it("loads as a data URL, which no site check trusts", () => {
        expect(recoveryPageUrl("crashed", "https://neore.ai/chat", "crashed").startsWith("data:text/html;charset=utf-8,")).toBe(true);
    });
});
