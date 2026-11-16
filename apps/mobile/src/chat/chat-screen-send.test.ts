/**
 * The chat screen's send path, read from its source: the screen has no render tests, so these pin the three lines whose
 * absence would lose an edit, move the route of a stopped send, or keep a stopped send waiting out its retry delay.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const screen = readFileSync(fileURLToPath(new URL("../../app/chat/[threadId].tsx", import.meta.url)), "utf8");
const STOPS_AFTER_START = /if \(isStoppedAfterStart\(\{ controller, ids: \{ assistant: assistantId, user: userId \}, sendSession \}\)\) \{\s*return;\s*\}/u;
const MOVES_ROUTE_ONLY_UNSTOPPED = /if \(shouldMoveRoute\(routeThreadId, controller\.signal\)\) \{\s*router\.setParams\(\{ threadId: started\.threadId \}\);/u;

describe("the chat screen's send", () => {
    it("sends the composer as the last write left it, not as the render saw it", () => {
        expect(screen).toContain("const prompt = draft.get().trim();");
        expect(screen).not.toContain("const prompt = draft.trim();");
    });

    it("moves no route for a send stopped before its start answered", () => {
        expect(screen).toContain("const shouldMoveRoute = (routeThreadId: string, signal: AbortSignal): boolean => routeThreadId === NEW_THREAD && !signal.aborted;");
        expect(screen).toMatch(MOVES_ROUTE_ONLY_UNSTOPPED);
    });

    it("changes nothing on the screen for a start that answered after its send was stopped", () => {
        expect(screen).toContain("const next = afterStart({ isAborted: controller.signal.aborted, isSignedOut: sendSession.isSignedOut() });");
        expect(screen).toMatch(STOPS_AFTER_START);
    });

    it("cuts its retry delay short when the send is stopped", () => {
        expect(screen).toContain("await abortableSleep(ms, controller.signal);");
    });
});
