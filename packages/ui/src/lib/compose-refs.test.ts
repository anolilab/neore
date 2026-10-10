import { describe, expect, it, vi } from "vitest";

import { composeRefs } from "./compose-refs";

// Use plain objects instead of DOM elements since UI package runs without jsdom
const createNode = () => {
    return { tagName: "DIV" };
};

describe("composeRefs", () => {
    it("should call callback refs with the node", () => {
        const ref1 = vi.fn();
        const ref2 = vi.fn();
        const composed = composeRefs(ref1, ref2);

        const node = createNode();

        composed(node);

        expect(ref1).toHaveBeenCalledWith(node);
        expect(ref2).toHaveBeenCalledWith(node);
    });

    it("should set RefObject refs", () => {
        const ref1 = { current: null as any };
        const ref2 = { current: null as any };
        const composed = composeRefs(ref1, ref2);

        const node = createNode();

        composed(node);

        expect(ref1.current).toBe(node);
        expect(ref2.current).toBe(node);
    });

    it("should handle mix of callback and object refs", () => {
        const callbackRef = vi.fn();
        const objectRef = { current: null as any };
        const composed = composeRefs(callbackRef, objectRef);

        const node = createNode();

        composed(node);

        expect(callbackRef).toHaveBeenCalledWith(node);
        expect(objectRef.current).toBe(node);
    });

    it("should skip undefined refs", () => {
        const ref1 = vi.fn();
        const composed = composeRefs(undefined, ref1, undefined);

        const node = createNode();

        composed(node);

        expect(ref1).toHaveBeenCalledWith(node);
    });

    it("should skip null refs", () => {
        const ref1 = vi.fn();
        const composed = composeRefs(null, ref1);

        const node = createNode();

        composed(node);

        expect(ref1).toHaveBeenCalledWith(node);
    });

    it("should return cleanup function when callback ref returns a cleanup", () => {
        const cleanup1 = vi.fn();
        const ref1 = vi.fn().mockReturnValue(cleanup1);
        const ref2 = { current: null as any };

        const composed = composeRefs(ref1, ref2);
        const node = createNode();
        const cleanupFunction = composed(node);

        expect(typeof cleanupFunction).toBe("function");

        // Execute cleanup
        (cleanupFunction as () => void)();
        expect(cleanup1).toHaveBeenCalled();
        // Object ref should be set to null on cleanup
        expect(ref2.current).toBeNull();
    });

    it("should return undefined when no callback ref returns a cleanup", () => {
        const ref1 = vi.fn(); // returns undefined by default
        const ref2 = { current: null as any };

        const composed = composeRefs(ref1, ref2);
        const node = createNode();
        const result = composed(node);

        expect(result).toBeUndefined();
    });
});
