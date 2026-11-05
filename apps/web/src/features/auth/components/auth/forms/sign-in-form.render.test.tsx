/**
 * `<SignInForm>`: what the visitor sees when sign-in is refused, and that a
 * failed attempt never leaves the typed password behind or keeps a spent captcha.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
    return {
        credentials: { forgotPassword: true, rememberMe: false } as Record<string, unknown>,
        getCaptchaHeaders: vi.fn(),
        navigate: vi.fn(),
        onSuccess: vi.fn(),
        resetCaptcha: vi.fn(),
        saveLastSignIn: vi.fn(),
        sendVerificationEmail: vi.fn(),
        signInEmail: vi.fn(),
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
    return { Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a> };
});

vi.mock("@/features/auth/lib/auth-ui-provider", () => {
    return {
        useAuth: () => {
            return {
                authClient: { sendVerificationEmail: harness.sendVerificationEmail, signIn: { email: harness.signInEmail } },
                basePath: "/auth",
                credentials: harness.credentials,
                navigate: harness.navigate,
                toast: harness.toast,
                viewPaths: { FORGOT_PASSWORD: "forgot-password", TWO_FACTOR: "two-factor" }, // secret-scanner:allow route names, not a credential
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

vi.mock("@/features/auth/hooks/use-last-signin-method", () => {
    return {
        default: () => {
            return { lastSignIn: null, saveLastSignIn: harness.saveLastSignIn };
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

vi.mock("@/lib/analytics", () => {
    return { trackEvent: harness.trackEvent };
});

vi.mock("../../captcha/captcha", () => {
    return { default: () => null };
});

const { default: SignInForm } = await import("./sign-in-form");

// The inputs are found by placeholder: `FormLabel` points at the control's wrapper
// <div>, not the <input>, so `getByLabelText` cannot reach them.
const emailInput = () => screen.getByPlaceholderText("Enter your email") as HTMLInputElement;
const passwordInput = () => screen.getByPlaceholderText("Enter your password") as HTMLInputElement;

const fill = (email: string, password: string) => {
    fireEvent.change(emailInput(), { target: { value: email } });
    fireEvent.change(passwordInput(), { target: { value: password } });
};

const submit = () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
};

beforeEach(() => {
    harness.credentials = { forgotPassword: true, rememberMe: false };
    harness.getCaptchaHeaders.mockResolvedValue({});
    harness.signInEmail.mockResolvedValue({});
});

afterEach(() => {
    vi.clearAllMocks();
});

describe("SignInForm", () => {
    it("labels both fields and links to password recovery", () => {
        render(<SignInForm />);

        expect(screen.getByText("Email")).toBeTruthy();
        expect(screen.getByText("Password")).toBeTruthy();
        expect(screen.getByRole("link", { name: "Forgot password?" }).getAttribute("href")).toContain("/auth/forgot-password");
    });

    it("signs in with the typed credentials and continues", async () => {
        render(<SignInForm />);
        fill("ada@example.com", "correct horse battery");
        submit();

        await waitFor(() => {
            expect(harness.onSuccess).toHaveBeenCalledTimes(1);
        });

        expect(harness.signInEmail).toHaveBeenCalledWith(expect.objectContaining({ email: "ada@example.com", password: "correct horse battery" }));
        expect(harness.toast).not.toHaveBeenCalled();
    });

    it("shows the translated message for a refused sign-in, clears the password and resets the captcha", async () => {
        harness.signInEmail.mockRejectedValue({ error: { code: "INVALID_EMAIL_OR_PASSWORD" }, status: 401 });
        render(<SignInForm />);
        fill("ada@example.com", "wrong password");
        submit();

        await waitFor(() => {
            expect(harness.toast).toHaveBeenCalledWith({ message: "Invalid email or password", variant: "error" });
        });

        expect(harness.resetCaptcha).toHaveBeenCalledTimes(1);
        expect(passwordInput().value).toBe("");
        expect(emailInput().value).toBe("ada@example.com");
        expect(harness.onSuccess).not.toHaveBeenCalled();
        expect(harness.saveLastSignIn).not.toHaveBeenCalled();
    });

    it("gets an unverified visitor a new link by signing in again with the kept password", async () => {
        harness.signInEmail.mockRejectedValue({ error: { code: "EMAIL_NOT_VERIFIED" }, status: 403 });
        render(<SignInForm />);
        fill("ada@example.com", "correct horse battery");
        submit();

        fireEvent.click(await screen.findByRole("button", { name: "Send a new verification link" }));

        await waitFor(() => {
            expect(harness.toast).toHaveBeenLastCalledWith({ message: "Verification email sent", variant: "success" });
        });

        // Never the unauthenticated endpoint: only a proven sign-in mails a link and renews a guest hand-over.
        expect(harness.sendVerificationEmail).not.toHaveBeenCalled();
        expect(harness.signInEmail).toHaveBeenCalledTimes(2);
        expect(harness.signInEmail).toHaveBeenLastCalledWith(expect.objectContaining({ email: "ada@example.com", password: "correct horse battery" }));
        expect(passwordInput().value).toBe("correct horse battery");
    });

    it("withdraws the new-link button once the email is edited", async () => {
        harness.signInEmail.mockRejectedValue({ error: { code: "EMAIL_NOT_VERIFIED" }, status: 403 });
        render(<SignInForm />);
        fill("ada@example.com", "correct horse battery");
        submit();

        await screen.findByRole("button", { name: "Send a new verification link" });
        fireEvent.change(emailInput(), { target: { value: "grace@example.com" } });

        expect(screen.queryByRole("button", { name: "Send a new verification link" })).toBeNull();
    });

    it("keeps the new-link button named and marks it busy while it works", async () => {
        harness.signInEmail.mockRejectedValueOnce({ error: { code: "EMAIL_NOT_VERIFIED" }, status: 403 });
        harness.signInEmail.mockReturnValueOnce(new Promise(() => {}));
        render(<SignInForm />);
        fill("ada@example.com", "correct horse battery");
        submit();

        fireEvent.click(await screen.findByRole("button", { name: "Send a new verification link" }));

        await waitFor(() => {
            expect(screen.getByRole("button", { name: "Send a new verification link" }).getAttribute("aria-busy")).toBe("true");
        });
    });

    it("offers no new link for any other refusal", async () => {
        harness.signInEmail.mockRejectedValue({ error: { code: "INVALID_EMAIL_OR_PASSWORD" }, status: 401 });
        render(<SignInForm />);
        fill("ada@example.com", "wrong");
        submit();

        await waitFor(() => expect(harness.toast).toHaveBeenCalled());
        expect(screen.queryByRole("button", { name: "Send a new verification link" })).toBeNull();
    });

    it("tells the visitor an unverified email is the reason", async () => {
        harness.signInEmail.mockRejectedValue({ error: { code: "EMAIL_NOT_VERIFIED" }, status: 403 });
        render(<SignInForm />);
        fill("ada@example.com", "correct horse battery");
        submit();

        await waitFor(() => {
            expect(harness.toast).toHaveBeenCalledWith({
                message: "Verify your email address first: we have sent you a new verification link.",
                variant: "error",
            });
        });
    });

    it("reports a network failure by its message, not as a refusal", async () => {
        harness.signInEmail.mockRejectedValue(new Error("Failed to fetch"));
        render(<SignInForm />);
        fill("ada@example.com", "correct horse battery");
        submit();

        await waitFor(() => {
            expect(harness.toast).toHaveBeenCalledWith({ message: "Failed to fetch", variant: "error" });
        });
    });

    it("reports a failing captcha without attempting the sign-in", async () => {
        harness.getCaptchaHeaders.mockRejectedValue(new Error("Missing captcha response"));
        render(<SignInForm />);
        fill("ada@example.com", "correct horse battery");
        submit();

        await waitFor(() => {
            expect(harness.toast).toHaveBeenCalledWith({ message: "Missing captcha response", variant: "error" });
        });

        expect(harness.signInEmail).not.toHaveBeenCalled();
    });

    it("sends a two-factor account to the second step instead of finishing", async () => {
        harness.signInEmail.mockResolvedValue({ twoFactorRedirect: true });
        render(<SignInForm />);
        fill("ada@example.com", "correct horse battery");
        submit();

        await waitFor(() => {
            expect(harness.navigate).toHaveBeenCalledTimes(1);
        });

        expect(String(harness.navigate.mock.calls[0]?.[0])).toContain("/auth/two-factor");
        expect(harness.onSuccess).not.toHaveBeenCalled();
    });

    /** A sign-in left unanswered, with the function that answers it. */
    const deferred = () => {
        let settle: (outcome: { reject?: unknown; resolve?: unknown }) => void = () => undefined;
        const promise = new Promise((resolve, reject) => {
            settle = ({ reject: rejection, resolve: value }) => (rejection === undefined ? resolve(value) : reject(rejection));
        });

        return { promise, settle };
    };

    it("does not submit while a new link is being requested, so the two never spend one captcha", async () => {
        harness.signInEmail.mockRejectedValueOnce({ error: { code: "EMAIL_NOT_VERIFIED" }, status: 403 });

        const resend = deferred();

        harness.signInEmail.mockReturnValueOnce(resend.promise);
        render(<SignInForm />);
        fill("ada@example.com", "correct horse battery");
        submit();

        fireEvent.click(await screen.findByRole("button", { name: "Send a new verification link" }));
        await waitFor(() => expect(harness.signInEmail).toHaveBeenCalledTimes(2));

        expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(true);
        // Enter in a field submits the form even with the button disabled.
        fireEvent.submit(passwordInput());
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });

        expect(harness.signInEmail).toHaveBeenCalledTimes(2);

        resend.settle({ reject: { error: { code: "EMAIL_NOT_VERIFIED" }, status: 403 } });
        await waitFor(() => expect(harness.toast).toHaveBeenLastCalledWith({ message: "Verification email sent", variant: "success" }));
        // The request that finished resets the captcha it spent.
        expect(harness.resetCaptcha).toHaveBeenCalledTimes(2);
    });

    it("does not request a new link while a sign-in is on its way", async () => {
        harness.signInEmail.mockRejectedValueOnce({ error: { code: "EMAIL_NOT_VERIFIED" }, status: 403 });

        const signIn = deferred();

        harness.signInEmail.mockReturnValueOnce(signIn.promise);
        render(<SignInForm />);
        fill("ada@example.com", "correct horse battery");
        submit();

        const resend = await screen.findByRole("button", { name: "Send a new verification link" });

        submit();
        await waitFor(() => expect(harness.signInEmail).toHaveBeenCalledTimes(2));

        expect((resend as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(resend);
        await new Promise((resolve) => {
            setTimeout(resolve, 50);
        });

        expect(harness.signInEmail).toHaveBeenCalledTimes(2);

        signIn.settle({ resolve: {} });
        await waitFor(() => expect(harness.onSuccess).toHaveBeenCalledTimes(1));
    });

    it("does not call the server for an invalid email, and says why", async () => {
        render(<SignInForm />);
        fill("not-an-email", "correct horse battery");
        submit();

        expect(await screen.findByText("Invalid email format or aliasing not allowed")).toBeTruthy();

        expect(harness.signInEmail).not.toHaveBeenCalled();
    });
});
