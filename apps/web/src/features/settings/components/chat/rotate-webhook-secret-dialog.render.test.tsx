import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import RotateWebhookSecretDialog from "./rotate-webhook-secret-dialog";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted).
vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

const OVERLAP = "Keep accepting the old secret for 24 hours";

describe("RotateWebhookSecretDialog", () => {
    it("opens unticked again after a rotation with the overlap closed it from the parent", () => {
        const onConfirm = vi.fn();
        const props = { loading: false, name: "Hook", onConfirm, onOpenChange: vi.fn() };
        const { rerender } = render(<RotateWebhookSecretDialog {...props} open />);

        fireEvent.click(screen.getByLabelText(OVERLAP));
        fireEvent.click(screen.getByRole("button", { name: "Rotate secret" }));
        expect(onConfirm).toHaveBeenCalledWith(true);

        rerender(<RotateWebhookSecretDialog {...props} open={false} />);
        rerender(<RotateWebhookSecretDialog {...props} open />);

        expect((screen.getByLabelText(OVERLAP) as HTMLInputElement).checked).toBe(false);
    });
});
