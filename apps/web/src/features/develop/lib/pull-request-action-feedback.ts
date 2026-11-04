import { useLingui } from "@lingui/react/macro";
import { useRef } from "react";

import { isPreHostRefusal } from "./use-pull-request-actions";
import type { WriteResult } from "./use-review-messages";
import { useReviewMessages } from "./use-review-messages";

/** The answer of a write, or the error it threw: a refusal the server named is a thrown coded error, a lost answer is not. */
export async function attempt<T>(promise: Promise<T>): Promise<{ outcome: T } | { thrown: unknown }> {
    try {
        return { outcome: await promise };
    } catch (error) {
        return { thrown: error };
    }
}

export type Feedback = { kind: "error"; text: string; unconfirmed: boolean } | { href?: string; kind: "success"; text: string };

/**
 * Each handler it wraps runs once at a time: a run is refused while the previous one of the same name is in flight. The flag is
 * set when the handler is called, which a disabled button cannot do: it turns off only after the next render, so a second click
 * can arrive before it.
 */
export const useSingleFlight = () => {
    const inFlight = useRef<Record<string, boolean>>({});

    return (name: string, run: () => Promise<void>) => async (): Promise<void> => {
        if (inFlight.current[name] === true) {
            return;
        }

        inFlight.current[name] = true;

        try {
            await run();
        } finally {
            inFlight.current[name] = false;
        }
    };
};

/** How a write's answer reads on the panel: a refusal, an unconfirmed answer, or the success text. */
export const useActionFeedback = (hostLabel: string) => {
    const { t } = useLingui();
    const messages = useReviewMessages(hostLabel);

    // Only an error the server raised before any host call says nothing changed; any other thrown error may have reached the host.
    const thrownFailure = (thrown: unknown): Feedback =>
        isPreHostRefusal(thrown)
            ? { kind: "error", text: t`The request was refused before it reached ${hostLabel}. Nothing was changed.`, unconfirmed: false }
            : { kind: "error", text: t`Could not confirm that. Check on ${hostLabel} before you try again.`, unconfirmed: true };

    // A host answer that is not ok: refused, or marked unconfirmed (its answer never came back).
    const failure = (outcome: WriteResult): Feedback => {
        return {
            kind: "error",
            text: messages.write(outcome),
            unconfirmed: outcome.status === "unconfirmed",
        };
    };

    // The feedback for a write's answer: the success text when the host took it, otherwise the refusal or the unconfirmed answer.
    const settled = (result: { outcome: WriteResult } | { thrown: unknown }, success: Feedback): Feedback => {
        if ("thrown" in result) {
            return thrownFailure(result.thrown);
        }

        return result.outcome.status === "ok" ? success : failure(result.outcome);
    };

    return { failure, settled, thrownFailure };
};
