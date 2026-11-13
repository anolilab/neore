// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChunkBatcher, ShownRow } from "./chunk-batcher";
import { appendTexts, createChunkBatcher } from "./chunk-batcher";
import { MessageRowView } from "./message-row";

const textRenders: string[] = [];

// The native primitives as plain DOM elements; `Text` records what it rendered, so a skipped row shows as no entry.
// eslint-disable-next-line no-restricted-syntax -- react-native's primitives cannot load in Node; there is nothing to inject
vi.mock(import("react-native"), () => ({
    Pressable: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
    Text: ({ children }: { children: ReactNode }) => {
        textRenders.push(String(children));

        return <span>{children}</span>;
    },
    View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
} as never));

const row = (id: string, text: string): ShownRow => {
    return { createdAt: 0, id, role: "assistant", shareText: text, status: "local", syncedAt: 0, text, threadId: "t", updatedAt: 0 };
};

const onShare = () => {};
const screenRenders = { count: 0 };
const frame: { run?: () => void } = {};
const wiring: { batcher?: ChunkBatcher } = {};

/** The chat screen's wiring: rows in state, a batcher that writes them once a frame, one memoised view per row. */
const Chat = ({ initial }: { initial: ShownRow[] }) => {
    const [rows, setRows] = useState(initial);
    const [batcher] = useState(() =>
        createChunkBatcher({
            apply: (texts) => {
                setRows((current) => appendTexts(current, texts));
            },
            cancelFrame: () => {
                frame.run = undefined;
            },
            requestFrame: (callback) => {
                frame.run = callback;

                return 1;
            },
        }),
    );

    screenRenders.count += 1;
    wiring.batcher = batcher;

    return (
        <ul>
            {rows.map((shown) => (
                <MessageRowView key={shown.id} onShare={onShare} row={shown} />
            ))}
        </ul>
    );
};

describe(MessageRowView, () => {
    const mounted: { container?: HTMLElement; root?: Root } = {};

    beforeEach(() => {
        // React reads this to allow `act` outside a testing library.
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
        mounted.container = document.createElement("div");
        mounted.root = createRoot(mounted.container);
    });

    afterEach(() => {
        act(() => {
            mounted.root?.unmount();
        });
        textRenders.length = 0;
        screenRenders.count = 0;
    });

    it("renders the chat once for a frame of chunks, and only the streaming row again", () => {
        act(() => {
            mounted.root?.render(<Chat initial={[row("question", "Why?"), row("older", "An earlier answer"), row("reply", "")]} />);
        });

        for (const chunk of ["Be", "cause ", "it ", "is", "."]) {
            act(() => {
                wiring.batcher?.add("reply", chunk);
            });
        }

        act(() => {
            frame.run?.();
        });

        expect(mounted.container?.textContent).toContain("Because it is.");
        expect(screenRenders.count).toBe(2);
        expect(textRenders.filter((text) => text === "Why?")).toHaveLength(1);
        expect(textRenders.filter((text) => text === "An earlier answer")).toHaveLength(1);
        expect(textRenders.filter((text) => text === "Because it is.")).toHaveLength(1);
    });
});
