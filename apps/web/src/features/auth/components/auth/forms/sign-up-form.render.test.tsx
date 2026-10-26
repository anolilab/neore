/**
 * `<SignUpForm>`: the invitation token reaches the sign-up request, and a
 * refused sign-up surfaces as a translated toast with the form reset.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        confirmPassword: false,
        getCaptchaHeaders: vi.fn(),
        navigate: vi.fn(),
        onSuccess: vi.fn(),
        resetCaptcha: vi.fn(),
        signUpEmail: vi.fn(),
        toast: vi.fn(),
        trackEvent: vi.fn(),
    };
});

vi.mock("@lingui/react/macro", () => {
    return {
        useLingui: () => {
            return { t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw({ raw: strings }, ...values) };
        },
    };
});

vi.mock("@tanstack/react-router", () => {
    return {
        useSearch: () => {
            return {};
        },
    };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                additionalFields: {},
                authClient: { signUp: { email: harness.signUpEmail } },
                avatar: false,
                basePath: "/auth",
                baseURL: "https://app.test",
                credentials: { confirmPassword: harness.confirmPassword },
                emailVerification: false,
                nameRequired: false,
                navigate: harness.navigate,
                persistClient: false,
                redirectTo: "/chat",
                signUp: { fields: ["name"] },
                toast: harness.toast,
                viewPaths: { CALLBACK: "callback", SIGN_IN: "sign-in" },
            };
        },
    };
});

vi.mock("@/features/auth/hooks/use-captcha", () => {
    return {
        default: () => {
            return { captchaRef: { current: null }, getCaptchaHeaders: harness.getCaptchaHeaders, resetCaptcha: harness.resetCaptcha };
        },
    };
});

vi.mock("@/features/auth/hooks/use-success-transition", () => {
    return {
        default: () => {
            return { isPending: false, onSuccess: harness.onSuccess };
        },
    };
});

vi.mock("@/features/auth/lib/image-utilities", () => {
    return { fileToBase64: vi.fn(), resizeAndCropImage: vi.fn() };
});

vi.mock("@/lib/analytics", () => {
    return { trackEvent: harness.trackEvent };
});

vi.mock("../../captcha/captcha", () => {
    return { default: () => null };
});

const { default: SignUpForm } = await import("./sign-up-form");

// The inputs are found by placeholder: `FormLabel` points at the control's wrapper
// <div>, not the <input>, so `getByLabelText` cannot reach them.
const input = (placeholder: string) => screen.getByPlaceholderText(placeholder) as HTMLInputElement;

const fill = (email = "ada@example.com", password = "correct horse battery") => {
    fireEvent.change(input("Enter your name"), { target: { value: "Ada" } });
    fireEvent.change(input("Enter your email"), { target: { value: email } });
    fireEvent.change(input("Enter your password"), { target: { value: password } });
};

const submit = () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign Up" }));
};

const visit = (search: string) => {
    globalThis.history.replaceState({}, "", `/auth/sign-up${search}`);
};

/** The body the form handed to `authClient.signUp.email`. */
const sentBody = (): Record<string, unknown> => harness.signUpEmail.mock.calls[0]?.[0] as Record<string, unknown>;

beforeEach(() => {
    harness.confirmPassword = false;
    harness.getCaptchaHeaders.mockResolvedValue({});
    harness.signUpEmail.mockResolvedValue({ token: "session-token" });
    visit("");
});

afterEach(() => {
    visit("");
    vi.clearAllMocks();
});

describe("SignUpForm", () => {
    it("sends the invitation token from the link with the sign-up", async () => {
        visit("?invite=tok-123");
        render(<SignUpForm />);
        fill();
        submit();

        await waitFor(() => {
            expect(harness.signUpEmail).toHaveBeenCalledTimes(1);
        });

        expect(sentBody()).toMatchObject({ email: "ada@example.com", inviteToken: "tok-123", name: "Ada", password: "correct horse battery" });
    });

    it.each(["", "?invite=", "?invite=%20%20"])("sends no inviteToken for %o", async (search) => {
        visit(search);
        render(<SignUpForm />);
        fill();
        submit();

        await waitFor(() => {
            expect(harness.signUpEmail).toHaveBeenCalledTimes(1);
        });

        expect(sentBody()).not.toHaveProperty("inviteToken");
    });

    it("never forwards the client-side confirmation to the server", async () => {
        harness.confirmPassword = true;
        render(<SignUpForm />);
        fill();
        fireEvent.change(input("Enter your password again"), { target: { value: "correct horse battery" } });
        submit();

        await waitFor(() => {
            expect(harness.signUpEmail).toHaveBeenCalledTimes(1);
        });

        expect(sentBody()).not.toHaveProperty("confirmPassword");
    });

    it("signs in and continues when the server answers with a session token", async () => {
        render(<SignUpForm />);
        fill();
        submit();

        await waitFor(() => {
            expect(harness.onSuccess).toHaveBeenCalledTimes(1);
        });

        expect(harness.toast).not.toHaveBeenCalled();
        expect(harness.navigate).not.toHaveBeenCalled();
    });

    it("sends the visitor to sign-in, keeping the query string, when no session was opened", async () => {
        harness.signUpEmail.mockResolvedValue({});
        visit("?invite=tok-123");
        render(<SignUpForm />);
        fill();
        submit();

        await waitFor(() => {
            expect(harness.navigate).toHaveBeenCalledWith("/auth/sign-in?invite=tok-123");
        });

        expect(harness.toast).toHaveBeenCalledWith({ message: "Sign up successful", variant: "success" });
        expect(harness.onSuccess).not.toHaveBeenCalled();
    });

    it("shows the translated message for a refused sign-up, resets the captcha and the form", async () => {
        harness.signUpEmail.mockRejectedValue({ error: { code: "USER_ALREADY_EXISTS" }, status: 422 });
        render(<SignUpForm />);
        fill();
        submit();

        await waitFor(() => {
            expect(harness.toast).toHaveBeenCalledWith({ message: "User already exists", variant: "error" });
        });

        expect(harness.resetCaptcha).toHaveBeenCalledTimes(1);
        expect(input("Enter your email").value).toBe("");
        expect(input("Enter your password").value).toBe("");
        expect(harness.onSuccess).not.toHaveBeenCalled();
        expect(harness.trackEvent).not.toHaveBeenCalled();
    });

    it("reports a failing captcha without sending the sign-up", async () => {
        harness.getCaptchaHeaders.mockRejectedValue(new Error("Missing captcha response"));
        render(<SignUpForm />);
        fill();
        submit();

        await waitFor(() => {
            expect(harness.toast).toHaveBeenCalledWith({ message: "Missing captcha response", variant: "error" });
        });

        expect(harness.signUpEmail).not.toHaveBeenCalled();
    });

    it("does not send an invalid email to the server", async () => {
        render(<SignUpForm />);
        fill("not-an-email");
        submit();

        expect(await screen.findByText("Invalid email format or aliasing not allowed")).toBeTruthy();

        expect(harness.signUpEmail).not.toHaveBeenCalled();
    });

    it("does not send mismatching passwords, and names the mismatch", async () => {
        harness.confirmPassword = true;
        render(<SignUpForm />);
        fill();
        fireEvent.change(input("Enter your password again"), { target: { value: "something else entirely" } });
        submit();

        expect(await screen.findByText("Passwords do not match")).toBeTruthy();
        expect(harness.signUpEmail).not.toHaveBeenCalled();
    });
});
