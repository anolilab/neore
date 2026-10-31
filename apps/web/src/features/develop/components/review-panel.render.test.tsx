/** Submitting a review waits for the verdict and summary saves still in flight. */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ReviewPanel from "./review-panel";

const HEAD_SHA = "a".repeat(40);

const { setReview, submit } = vi.hoisted(() => {
    return {
        setReview: vi.fn(),
        submit: vi.fn(async () => {
            return { reviewUrl: "https://example.com/review/1", status: "ok" };
        }),
    };
});

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    const text = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values);

    return {
        Plural: ({ value }: { value: number }) => <>{value}</>,
        Trans: ({ children }: { children: unknown }) => <>{children as never}</>,
        useLingui: () => {
            return { i18n: { _: (descriptor: { id: string }) => descriptor.id, locale: "en" }, t: text };
        },
    };
});

vi.mock("@neore/backend/source-control/capabilities", () => {
    return {
        hostCapabilityOf: () => {
            return { degradation: "none", supported: true };
        },
        isHostCapabilityAvailable: () => true,
    };
});

vi.mock("../lib/use-review", () => {
    return {
        useDraftMutations: () => {
            return {
                deleteComment: { mutateAsync: vi.fn() },
                discard: { mutateAsync: vi.fn() },
                saveComment: { mutateAsync: vi.fn() },
                setReview: { mutateAsync: setReview },
            };
        },
        useReviewActions: () => {
            return { submit: { isPending: false, mutateAsync: submit } };
        },
        useReviewDraft: () => {
            return { data: { body: "Looks fine", comments: [], commitId: "a".repeat(40), submitting: false, verdict: "comment" } };
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

describe("ReviewPanel", () => {
    it("posts the review only after the verdict just chosen is stored", async () => {
        let storeVerdict: (outcome: { status: string }) => void = () => {};
        // The tsconfig lib predates `Promise.withResolvers`.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const stored = new Promise<{ status: string }>((resolve) => {
            storeVerdict = resolve;
        });

        setReview.mockImplementation(async () => await stored);
        submit.mockClear();

        render(<ReviewPanel address={{ number: 7, repository: "octo/hello" }} capabilities={{ groups: [] } as never} headSha={HEAD_SHA} hostLabel="GitHub" />);

        fireEvent.click(screen.getByRole("radio", { name: "Approve" }));
        fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

        await waitFor(() => {
            expect(setReview).toHaveBeenCalledTimes(1);
        });

        // The save has not answered: the stored verdict is still the old one, so nothing may be posted yet.
        expect(submit).not.toHaveBeenCalled();

        storeVerdict({ status: "ok" });

        await waitFor(() => {
            expect(submit).toHaveBeenCalledTimes(1);
        });
    });

    it("posts nothing when the verdict could not be stored", async () => {
        setReview.mockImplementation(async () => {
            return { status: "failed" };
        });
        submit.mockClear();

        render(<ReviewPanel address={{ number: 7, repository: "octo/hello" }} capabilities={{ groups: [] } as never} headSha={HEAD_SHA} hostLabel="GitHub" />);

        fireEvent.click(screen.getByRole("radio", { name: "Request changes" }));
        fireEvent.click(screen.getByRole("button", { name: "Submit review" }));

        await waitFor(() => {
            expect(setReview).toHaveBeenCalled();
        });
        await screen.findByRole("alert");

        expect(submit).not.toHaveBeenCalled();
    });
});
