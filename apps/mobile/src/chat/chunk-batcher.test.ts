import { describe, expect, it, vi } from "vitest";

import type { ShownRow } from "./chunk-batcher";
import { appendTexts, createChunkBatcher } from "./chunk-batcher";

const row = (id: string, text: string): ShownRow => {
    return { createdAt: 0, id, role: "assistant", shareText: text, status: "local", syncedAt: 0, text, threadId: "t", updatedAt: 0 };
};

/** A frame clock driven by the test: `tick` runs what was scheduled for the next frame. */
const frames = () => {
    const scheduled = new Map<number, () => void>();
    let next = 1;

    return {
        cancelFrame: (handle: number) => {
            scheduled.delete(handle);
        },
        pending: () => scheduled.size,
        requestFrame: (callback: () => void) => {
            const handle = next;

            next += 1;
            scheduled.set(handle, callback);

            return handle;
        },
        tick: () => {
            const callbacks = scheduled.values().toArray();

            scheduled.clear();

            for (const callback of callbacks) {
                callback();
            }
        },
    };
};

describe(appendTexts, () => {
    it("replaces only the rows that got text; the others keep their identity", () => {
        const rows = [row("a", "Hi"), row("b", "Hel"), row("c", "")];
        const next = appendTexts(rows, new Map([["b", "lo"]]));

        expect(next).not.toBe(rows);
        expect(next[0]).toBe(rows[0]);
        expect(next[2]).toBe(rows[2]);
        expect(next[1]).toMatchObject({ shareText: "Hello", text: "Hello" });
    });

    it("returns the same array when no row on screen gets text", () => {
        const rows = [row("a", "Hi")];

        expect(appendTexts(rows, new Map([["gone", "x"]]))).toBe(rows);
        expect(appendTexts(rows, new Map())).toBe(rows);
    });
});

describe(createChunkBatcher, () => {
    it("applies any number of chunks in one frame as one update", () => {
        const clock = frames();
        const apply = vi.fn();
        const batcher = createChunkBatcher({ apply, cancelFrame: clock.cancelFrame, requestFrame: clock.requestFrame });

        for (let index = 0; index < 40; index += 1) {
            batcher.add("reply", (index % 10).toString());
        }

        expect(apply).not.toHaveBeenCalled();
        expect(clock.pending()).toBe(1);

        clock.tick();

        expect(apply).toHaveBeenCalledOnce();
        expect(apply.mock.calls[0]?.[0]).toStrictEqual(new Map([["reply", "0123456789".repeat(4)]]));
    });

    it("updates the screen state once per frame, and only the streaming row", () => {
        const clock = frames();
        const before = [row("question", "Why?"), row("older", "An earlier answer"), row("reply", "")];
        let rows = before;
        let updates = 0;
        const batcher = createChunkBatcher({
            apply: (texts) => {
                updates += 1;
                rows = appendTexts(rows, texts);
            },
            cancelFrame: clock.cancelFrame,
            requestFrame: clock.requestFrame,
        });

        for (const chunk of ["Be", "cause ", "it ", "is."]) {
            batcher.add("reply", chunk);
        }

        clock.tick();
        batcher.add("reply", " Done.");
        clock.tick();

        expect(updates).toBe(2);
        expect(rows[0]).toBe(before[0]);
        expect(rows[1]).toBe(before[1]);
        expect(rows[2]?.text).toBe("Because it is. Done.");
    });

    it("flushes now, in order, and leaves no frame scheduled", () => {
        const clock = frames();
        const applied: string[] = [];
        const batcher = createChunkBatcher({
            apply: (texts) => {
                applied.push([...texts].map(([id, text]) => `${id}:${text}`).join(","));
            },
            cancelFrame: clock.cancelFrame,
            requestFrame: clock.requestFrame,
        });

        batcher.add("first", "before the steer");
        batcher.flush();
        batcher.add("second", "after it");
        batcher.flush();
        batcher.flush();
        clock.tick();

        expect(applied).toStrictEqual(["first:before the steer", "second:after it"]);
        expect(clock.pending()).toBe(0);
    });

    it("drops what is queued when the send is stopped", () => {
        const clock = frames();
        const apply = vi.fn();
        const batcher = createChunkBatcher({ apply, cancelFrame: clock.cancelFrame, requestFrame: clock.requestFrame });

        batcher.add("reply", "late");
        batcher.discard();
        clock.tick();
        batcher.flush();

        expect(apply).not.toHaveBeenCalled();
    });
});
