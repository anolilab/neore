/**
 * An incomplete check listing must not read "All required checks passed": the rollup only covers the checks shown.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ChecksTab from "./checks-tab";

const { checks } = vi.hoisted(() => {
    return { checks: { current: {} as { complete: boolean } } };
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

vi.mock("@lingui/core/macro", () => {
    return { plural: (count: number, forms: { one: string; other: string }) => (count === 1 ? forms.one : forms.other) };
});

vi.mock("@neore/backend/source-control/capabilities", () => {
    return { isHostCapabilityAvailable: () => true };
});

vi.mock("../lib/use-develop", () => {
    return {
        usePullRequestChecks: () => {
            return {
                data: {
                    checks: [{ conclusion: "success", id: "1", name: "build", required: true, state: "success", url: null }],
                    rollup: { complete: checks.current.complete, failing: 0, optionalFailing: 0, pending: 0, state: "passing", waiting: [] },
                    status: "ok",
                    total: 1,
                },
                isError: false,
                isPending: false,
            };
        },
    };
});

vi.mock("../lib/use-merge", () => {
    return {
        useChecksAndMergeActions: () => {
            return { rerun: { mutateAsync: vi.fn() } };
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

const renderTab = () =>
    render(<ChecksTab address={{ number: 7, repository: "octo/hello" }} capabilities={{} as never} headSha={"a".repeat(40)} hostLabel="GitHub" />);

describe("ChecksTab summary", () => {
    it("says all required checks passed when the listing is complete", () => {
        checks.current = { complete: true };

        renderTab();

        expect(screen.getByText("All required checks passed.")).toBeTruthy();
    });

    it("does not claim that when the listing is incomplete", () => {
        checks.current = { complete: false };

        renderTab();

        expect(screen.getByText("No failures in the checks shown.")).toBeTruthy();
        expect(screen.queryByText("All required checks passed.")).toBeNull();
    });
});
