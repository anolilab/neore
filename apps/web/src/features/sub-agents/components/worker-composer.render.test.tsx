/**
 * The worker composer is the composer of a worker thread: F6 must reach it as it reaches the cloud composer's editor.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { focusNextArea } from "@/features/keyboard/lib/focus-areas";

vi.mock("@lingui/react/macro", () => {
    const t = (strings: TemplateStringsArray | string, ...values: unknown[]) =>
        typeof strings === "string" ? strings : String.raw({ raw: strings }, ...values);

    return {
        useLingui: () => {
            return { t };
        },
    };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return { isPending: false, mutate: () => {} };
        },
    };
});

vi.mock("@/lib/lunora/crpc", () => {
    return {
        useCRPC: () => {
            return {
                sub_agents: {
                    functions: {
                        dispatchToWorker: {
                            mutationOptions: () => {
                                return {};
                            },
                        },
                    },
                },
            };
        },
    };
});

vi.mock("@/lib/toast", () => {
    return { showError: () => {} };
});

const { default: WorkerComposer } = await import("./worker-composer");

describe("the worker composer", () => {
    it("is a focus area for F6, as the cloud composer is, so F6 reaches it", () => {
        render(<WorkerComposer archived={false} busy={false} followUp="queue" workerId="w1" />);

        const box = screen.getByLabelText("Message the worker") as HTMLTextAreaElement;

        expect(box.dataset.focusArea).toBe("composer");

        // jsdom does no layout: the box is given one, as it has on the page, so F6 can count it as shown.
        Object.assign(box, {
            getBoundingClientRect: () => {
                return { bottom: 40, height: 40, left: 0, right: 300, top: 0, width: 300 };
            },
            getClientRects: () => [{}],
        });

        expect(focusNextArea(1)).toBe(true);
        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        expect(document.activeElement).toBe(box);
    });
});
