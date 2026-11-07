// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { BranchNode, ThreadGroup } from "../types";
import ThreadGroupRenderer from "./thread-group-renderer";

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        Plural: () => null,
        useLingui: () => {
            return { i18n: { _: (value: string) => value }, t };
        },
    };
});

vi.mock("../group-header", () => {
    return { default: () => null };
});

// The rows are stubbed: the test checks the keyboard selection each top-level row is given.
const rowProps = vi.hoisted(() => [] as { isKeyboardSelected: boolean; keyboardThreadId?: string; threadId: string }[]);

vi.mock("../sortable-thread-item", () => {
    return {
        default: (props: { isKeyboardSelected: boolean; keyboardThreadId?: string; node: { threadId: string } }) => {
            rowProps.push({ isKeyboardSelected: props.isKeyboardSelected, keyboardThreadId: props.keyboardThreadId, threadId: props.node.threadId });

            return null;
        },
    };
});

const thread = (threadId: string): BranchNode => ({ children: [], threadId, title: threadId }) as unknown as BranchNode;

describe("a thread group in a short list", () => {
    it("gives the keyboard-selected thread its highlight, by id, and passes the id to its rows", () => {
        const first = thread("t1");
        const second = thread("t2");
        const group = { groupType: "today", threads: [first, second], title: "Today" } as unknown as ThreadGroup;
        const props = {
            currentThreadId: undefined,
            expandedThreads: new Set<string>(),
            flattenedThreads: [first, second],
            getGroupThreadIds: () => [],
            group,
            handleCreateBranch: () => {},
            handleDeleteProject: () => {},
            handleDeleteThread: () => {},
            handleDownloadThread: () => {},
            handleEditProject: () => {},
            handleGroupToggle: () => {},
            handleMouseEnter: () => {},
            handlePinProject: () => {},
            handlePinThread: () => {},
            handleThreadToggle: () => {},
            handleUnpinThread: () => {},
            isKeyboardNavigating: true,
            isSelectionMode: false,
            loadingStates: {},
            searchQuery: "",
            selectedThreadIds: new Set<string>(),
            selectedThreadIndex: 1,
            toggleExpanded: () => {},
            toggleGroupCollapsed: () => {},
            updateThread: () => {},
        } as unknown as Parameters<typeof ThreadGroupRenderer>[0];

        rowProps.length = 0;
        render(<ThreadGroupRenderer {...props} />);

        const selected = rowProps.find((row) => row.threadId === "t2");

        expect(selected?.isKeyboardSelected).toBe(true);
        expect(selected?.keyboardThreadId).toBe("t2");
        expect(rowProps.find((row) => row.threadId === "t1")?.isKeyboardSelected).toBe(false);
    });
});
