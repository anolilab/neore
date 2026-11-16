// @vitest-environment jsdom

import type { RefObject } from "react";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useFocusableCodeBlocks } from "./use-focusable-code-blocks";

// React only batches updates inside `act` when this flag is set.
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

/** A Streamdown code block: the scrolling body and its `<pre>`. */
const codeBlock = (language?: string): HTMLDivElement => {
    const body = document.createElement("div");
    const pre = document.createElement("pre");

    body.dataset.streamdown = "code-block-body";

    if (language) {
        pre.className = `language-${language}`;
    }

    pre.append(document.createElement("code"));
    body.append(pre);

    return body;
};

const hosts: { container: HTMLElement; unmount: () => void }[] = [];

/** Mounts the hook on a fresh reply root that already holds `initial`, and returns that root. */
const mount = (initial: HTMLElement[]): HTMLElement => {
    const container = document.createElement("div");
    const reply: { current: HTMLElement | null } = { current: null };

    document.body.append(container);

    const Probe = () => {
        const ref = useRef<HTMLDivElement>(null);

        useFocusableCodeBlocks(ref as RefObject<HTMLElement | null>, "Code block");

        return (
            <div
                ref={(node) => {
                    ref.current = node;
                    reply.current = node;
                    node?.append(...initial);
                }}
            />
        );
    };

    const root = createRoot(container);

    act(() => root.render(<Probe />));
    hosts.push({ container, unmount: () => act(() => root.unmount()) });

    return reply.current!;
};

/** Lets the MutationObserver deliver its records. */
const flush = (): Promise<void> =>
    act(async () => {
        await Promise.resolve();
    });

afterEach(() => {
    for (const { container, unmount } of hosts) {
        unmount();
        container.remove();
    }

    hosts.length = 0;
});

describe(useFocusableCodeBlocks, () => {
    it("marks every code block present at mount", () => {
        expect.assertions(4);

        const reply = mount([codeBlock("ts"), codeBlock()]);
        const [first, second] = reply.querySelectorAll("pre");

        expect(first!.tabIndex).toBe(0);
        expect(first!.getAttribute("aria-label")).toBe("ts");
        expect(second!.getAttribute("role")).toBe("region");
        expect(second!.getAttribute("aria-label")).toBe("Code block");
    });

    it("marks a code block added later, also when it arrives inside a larger node", async () => {
        expect.assertions(4);

        const reply = mount([]);
        const wrapper = document.createElement("div");

        wrapper.append(codeBlock("py"));
        reply.append(codeBlock("rust"), wrapper);
        await flush();

        const [rust, py] = reply.querySelectorAll("pre");

        expect(rust!.getAttribute("aria-label")).toBe("rust");
        expect(rust!.tabIndex).toBe(0);
        expect(py!.getAttribute("aria-label")).toBe("py");
        expect(py!.getAttribute("role")).toBe("region");
    });

    it("relabels a block whose language class arrives after it opened", async () => {
        expect.assertions(2);

        const reply = mount([codeBlock("t")]);
        const pre = reply.querySelector("pre")!;

        expect(pre.getAttribute("aria-label")).toBe("t");

        pre.className = "language-ts";
        await flush();

        expect(pre.getAttribute("aria-label")).toBe("ts");
    });

    it("touches only the added block when one block is added", async () => {
        expect.assertions(2);

        const reply = mount([codeBlock("ts"), codeBlock("go")]);
        const existing = [...reply.querySelectorAll("pre")];
        const setAttribute = vi.spyOn(HTMLElement.prototype, "setAttribute");

        reply.append(codeBlock("sh"));
        // Streaming text into an existing block is not a new block either.
        existing[0]!.querySelector("code")!.append(document.createElement("span"));
        await flush();

        const touched = new Set(setAttribute.mock.contexts);

        setAttribute.mockRestore();

        expect(existing.some((pre) => touched.has(pre))).toBe(false);
        expect(touched.has(reply.querySelectorAll("pre")[2]!)).toBe(true);
    });
});
