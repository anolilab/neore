/**
 * The chat screen's send path, read from its source: the screen has no render tests, so these pin the three lines whose
 * absence would lose an edit, move the route of a stopped send, or keep a stopped send waiting out its retry delay.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const screen = readFileSync(fileURLToPath(new URL("../../app/chat/[threadId].tsx", import.meta.url)), "utf8");
const MOVES_ROUTE_ONLY_UNSTOPPED = /if \(shouldMoveRoute\(routeThreadId, controller\.signal\)\) \{\s*router\.setParams\(\{ threadId: started\.threadId \}\);/u;

describe("the chat screen's send", () => {
    it("plans the press from the composer as the last write left it, not as the render saw it", () => {
        expect(screen).toContain("planSend(heldSend.current, draftRef.current)");
        expect(screen).not.toContain("planSend(heldSend.current, draft)");
    });

    it("moves no route for a send stopped before its start answered", () => {
        expect(screen).toContain("const shouldMoveRoute = (routeThreadId: string, signal: AbortSignal): boolean => routeThreadId === NEW_THREAD && !signal.aborted;");
        expect(screen).toMatch(MOVES_ROUTE_ONLY_UNSTOPPED);
    });

    it("cuts its retry delay short when the send is stopped", () => {
        expect(screen).toContain("await abortableSleep(ms, controller.signal);");
    });
});
