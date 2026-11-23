/**
 * Auto-merge can be on while the host shows this account no merge methods (the repository's settings come
 * back only to some accounts): the control that turns it off must still be there.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MergePanel from "./merge-panel";

const { autoMerge, mergeStatus, status } = vi.hoisted(() => {
    return {
        mergeStatus: vi.fn(),
        autoMerge: {
            mutateAsync: vi.fn(async () => {
                return { status: "ok" };
            }),
        },
        status: {
            current: {} as {
                data?: { autoMergeAllowed: boolean; autoMergeEnabled: boolean; methods: string[]; state: string; status: string };
                isError?: boolean;
                isPending?: boolean;
            },
        },
    };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t: text };
        },
    };
});

vi.mock("@neore/ui/components/confirm-dialog", () => {
    return {
        default: ({ confirmLabel, onConfirm, open }: { confirmLabel?: string; onConfirm: () => void; open: boolean }) =>
            open ? <button onClick={onConfirm} type="button">{`confirm:${String(confirmLabel)}`}</button> : null,
    };
});

vi.mock("../lib/use-merge", () => {
    return {
        useChecksAndMergeActions: () => {
            return { autoMerge: { ...autoMerge, isPending: false }, merge: { isPending: false, mutateAsync: vi.fn() } };
        },
        useMergeStatus: (...args: unknown[]) => {
            mergeStatus(...args);

            return status.current;
        },
    };
});

vi.mock("../lib/use-review-messages", () => {
    return {
        useReviewMessages: () => {
            return { edit: String, write: String };
        },
    };
});

const UNKNOWN_METHODS = /does not show which ways of merging/u;
const NATIVE = { degradation: "none", supported: true };
const capabilities = { groups: { merge: { auto: NATIVE, now: NATIVE } } } as never;

const ready = (overrides: { autoMergeEnabled?: boolean }) => {
    status.current = {
        data: { autoMergeAllowed: true, autoMergeEnabled: false, methods: [], state: "clean", status: "ok", ...overrides },
        isError: false,
        isPending: false,
    };
};

const renderPanel = () =>
    render(
        <MergePanel
            address={{ number: 7, repository: "octo/hello" }}
            baseBranch="main"
            capabilities={capabilities}
            headSha={"a".repeat(40)}
            hostLabel="GitHub"
            requestNoun="pull request"
        />,
    );

describe("MergePanel with no merge method allowed", () => {
    beforeEach(() => {
        autoMerge.mutateAsync.mockClear();
    });

    it("says the methods are unknown and offers nothing when auto-merge is off", () => {
        ready({});

        renderPanel();

        expect(screen.getByText(UNKNOWN_METHODS)).toBeTruthy();
        expect(screen.queryByRole("button")).toBeNull();
    });

    it("reads mergeability for the pull request's base and head, the read Catch up shares", () => {
        ready({});

        renderPanel();

        expect(mergeStatus).toHaveBeenCalledWith({ number: 7, repository: "octo/hello" }, true, { baseBranch: "main", headSha: "a".repeat(40) });
    });

    it("still turns auto-merge off when it is on", async () => {
        ready({ autoMergeEnabled: true });

        renderPanel();

        expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Turn off auto-merge" }));
        fireEvent.click(screen.getByRole("button", { name: "confirm:Turn off" }));

        await vi.waitFor(() => expect(autoMerge.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ enabled: false })));
    });
});
