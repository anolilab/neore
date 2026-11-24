/**
 * The worker composer is the composer of a worker thread: F6 must reach it as it reaches the cloud composer's editor,
 * and it shows the worker's live cloud browser as the chat composer does.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { prefillComposer } from "@/features/chat/thread/composer-prefill";
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

const { sent } = vi.hoisted(() => {
    return { sent: { onSuccess: undefined as (() => void) | undefined } };
});

vi.mock("@tanstack/react-query", () => {
    return {
        useMutation: () => {
            return {
                isPending: false,
                mutate: (_input: unknown, options: { onSuccess: () => void }) => {
                    sent.onSuccess = options.onSuccess;
                },
            };
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

// The card itself is covered by `browser-live-view.render.test.tsx`: here, only which thread it is mounted for.
vi.mock("@/features/chat/browser-live-view/browser-live-view", () => {
    return {
        default: ({ threadId }: { threadId: string | undefined }) => <section aria-label="Agent browser" data-thread-id={threadId} />,
    };
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

    it("shows the worker's live cloud browser, for the worker's own thread", () => {
        render(<WorkerComposer archived={false} busy={false} followUp="queue" workerId="w1" />);

        expect(screen.getByRole("region", { name: "Agent browser" }).dataset.threadId).toBe("w1");
    });

    it("takes a fix prompt for its own thread after the draft, unsent, and leaves another thread's", () => {
        render(<WorkerComposer archived={false} busy={false} followUp="queue" workerId="w2" />);

        const box = screen.getByLabelText("Message the worker") as HTMLTextAreaElement;

        act(() => {
            prefillComposer("other", "not this one");
            prefillComposer("w2", "Fix checks on octo/hello#7");
        });

        expect(box.value).toBe("Fix checks on octo/hello#7");
        // eslint-disable-next-line testing-library/no-node-access -- focus placement is what this asserts
        expect(document.activeElement).toBe(box);
    });

    it("keeps a fix prompt that arrived while a send ran, cleaned of hidden characters, and drops only the sent text", () => {
        render(<WorkerComposer archived={false} busy={false} followUp="queue" workerId="w3" />);

        const box = screen.getByLabelText("Message the worker") as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "run the tests" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        act(() => {
            prefillComposer("w3", "Fix checks\u{202E} on octo/hello#7");
        });

        expect(box.value).toBe("run the tests\nFix checks on octo/hello#7");

        act(() => {
            sent.onSuccess?.();
        });

        expect(box.value).toBe("Fix checks on octo/hello#7");
    });

    it("empties a draft edited while its send ran, so the sent message does not stay to go out twice", () => {
        render(<WorkerComposer archived={false} busy={false} followUp="queue" workerId="w4" />);

        const box = screen.getByLabelText("Message the worker") as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "run the tests" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        fireEvent.change(box, { target: { value: "run the test" } });
        act(() => {
            sent.onSuccess?.();
        });

        expect(box.value).toBe("");
    });

    it("keeps a fix prompt that arrived after the draft was edited during its send, and drops the edit", () => {
        render(<WorkerComposer archived={false} busy={false} followUp="queue" workerId="w5" />);

        const box = screen.getByLabelText("Message the worker") as HTMLTextAreaElement;

        fireEvent.change(box, { target: { value: "run the tests" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        fireEvent.change(box, { target: { value: "run the test" } });
        act(() => {
            prefillComposer("w5", "Fix checks on octo/hello#7");
        });
        act(() => {
            sent.onSuccess?.();
        });

        expect(box.value).toBe("Fix checks on octo/hello#7");
    });
});
