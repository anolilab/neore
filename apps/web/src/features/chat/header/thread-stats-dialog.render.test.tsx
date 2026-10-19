// @vitest-environment jsdom

/**
 * The statistics dialog's loading and failure states are announced to assistive
 * technology, and a partly priced thread says its total is a floor. The query is
 * stubbed; the summary is the real one.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        query: { data: undefined as unknown, isError: false, isPending: true } as { data?: unknown; isError: boolean; isPending: boolean },
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return {
                i18n: { locale: "en" },
                t: (strings: TemplateStringsArray | string, ...values: unknown[]) =>
                    typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values),
            };
        },
    };
});

vi.mock("@tanstack/react-query", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("@tanstack/react-query")>()),
        useQuery: () => harness.query,
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    const query = {
        queryOptions: () => {
            return { queryFn: async () => null, queryKey: ["thread-export"] };
        },
    };

    return {
        useCRPC: () => {
            return { chat: { functions: { getFullThreadForExport: query } } };
        },
    };
});

// The export rows are already the UI shape the summary reads, so the conversion is the identity.
vi.mock("@/lib/agent", () => {
    return {
        toUIMessages: (rows: { cost?: unknown; message: { role: string }; usage?: unknown }[]) =>
            rows.map((row) => {
                return { cost: row.cost, role: row.message.role, usage: row.usage };
            }),
    };
});

const { default: ThreadStatsDialog } = await import("./thread-stats-dialog");

const renderDialog = () => render(<ThreadStatsDialog model="gpt-4o" onOpenChange={() => undefined} open threadId="thread-1" />);

interface RowFields {
    _id: string;
    cost?: { byok: boolean; microdollars: number; pricingAvailable: boolean };
    order?: number;
    usage?: { completionTokens?: number; promptTokens?: number };
}

const UNPRICED_NOTE = /unpriced replies/;
const LOWER_BOUND = /≥/;

const assistantRow = (fields: RowFields) => {
    return {
        message: { role: "assistant" },
        model: "gpt-4o",
        order: 1,
        stepOrder: 0,
        threadId: "thread-1",
        ...fields,
    };
};

beforeEach(() => {
    harness.query = { data: undefined, isError: false, isPending: true };
});

describe("ThreadStatsDialog announcements", () => {
    it("announces the loading state as a polite status", () => {
        renderDialog();

        const status = screen.getByRole("status");

        expect(status.textContent).toBe("Loading statistics…");
        expect(status.getAttribute("aria-live")).toBe("polite");
    });

    it("announces a failed load as an alert", () => {
        harness.query = { data: undefined, isError: true, isPending: true };

        renderDialog();

        expect(screen.getByRole("alert").textContent).toBe("Could not load statistics for this thread.");
        expect(screen.queryByRole("status")).toBeNull();
    });
});

describe("ThreadStatsDialog partial cost", () => {
    it("shows a lower bound and the unpriced note when a reply that spent tokens has no cost", () => {
        harness.query = {
            data: {
                messages: [
                    assistantRow({
                        cost: { byok: false, microdollars: 2_000_000, pricingAvailable: true },
                        usage: { completionTokens: 4, promptTokens: 6 },
                        _id: "a",
                    }),
                    assistantRow({ _id: "b", order: 2, usage: { completionTokens: 9, promptTokens: 3 } }),
                ],
            },
            isError: false,
            isPending: false,
        };

        renderDialog();

        expect(screen.getByText(UNPRICED_NOTE)).toBeTruthy();
        expect(screen.getByText(LOWER_BOUND)).toBeTruthy();
    });

    it("shows the exact total with no note when every reply is priced", () => {
        harness.query = {
            data: {
                messages: [
                    assistantRow({
                        _id: "a",
                        cost: { byok: false, microdollars: 2_000_000, pricingAvailable: true },
                        usage: { completionTokens: 4, promptTokens: 6 },
                    }),
                ],
            },
            isError: false,
            isPending: false,
        };

        renderDialog();

        expect(screen.queryByText(UNPRICED_NOTE)).toBeNull();
        expect(screen.queryByText(LOWER_BOUND)).toBeNull();
    });
});
