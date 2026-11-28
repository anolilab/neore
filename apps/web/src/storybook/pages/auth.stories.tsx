import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AnyRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { expect, userEvent, within } from "storybook/test";

import ConvertAnonymousAccount from "@/features/auth/components/auth/convert-anonymous-account";
import LoginModal from "@/features/auth/components/auth/login-modal";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import AuthUIProviderTanstack from "@/features/auth/lib/tanstack/auth-ui-provider-tanstack";
import { Route as AcceptInvitationRoute } from "@/routes/auth/accept-invitation/$invitationId/index";
import { Route as DeviceRoute } from "@/routes/auth/device";
import { Route as ForgotPasswordRoute } from "@/routes/auth/forgot-password";
import { Route as RecoverAccountRoute } from "@/routes/auth/recover-account";
import { Route as ResetPasswordRoute } from "@/routes/auth/reset-password";
import { Route as AuthLayoutRoute } from "@/routes/auth/route";
import { Route as SignInRoute } from "@/routes/auth/sign-in";
import { Route as SignUpRoute } from "@/routes/auth/sign-up";
import { Route as TwoFactorRoute } from "@/routes/auth/two-factor/index";
import { DEVICE_CODE, deviceCodeHandlers, INVITATION_ID, invitationHandlers, signInMethodsHandlers } from "@/storybook/fixtures/auth-pages";
import { lunoraHandlers } from "@/storybook/lunora";
import { StoryPage } from "@/storybook/page";

// The page waits for the backend's list of sign-in methods before it knows what to offer; four browser projects share a machine.
const PAGE_WAIT = { timeout: 15_000 } as const;

/**
 * The pages a visitor meets before the app: they sit in the `/auth` layout (the canvas with one raised panel), not in
 * the app shell. Everything is signed out except the two that need an account (accepting an invitation, approving a code).
 */
const meta = {
    args: { levels: [], url: "/auth/sign-in" },
    component: StoryPage,
    parameters: {
        layout: "fullscreen",
        msw: { handlers: { authMethods: signInMethodsHandlers(), lunora: lunoraHandlers() } },
        persona: "signed-out",
    },
    title: "Pages/Auth",
} satisfies Meta<typeof StoryPage>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The `/auth` layout, then the page. */
const at = (page: { path: string; route: AnyRoute }, url: string) => {
    return {
        levels: [
            { path: "auth", route: AuthLayoutRoute as AnyRoute },
            { path: page.path, route: page.route },
        ],
        url,
    };
};

/** Email and password, with the providers the backend offers and a passkey row under the divider. */
export const SignIn: Story = {
    args: at({ path: "sign-in", route: SignInRoute }, "/auth/sign-in"),
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Sign in with GitHub" }, PAGE_WAIT)).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Sign in with passkey" })).toBeVisible();
    },
};

/** A wrong address is named under the field as soon as it is left. */
export const SignInError: Story = {
    args: at({ path: "sign-in", route: SignInRoute }, "/auth/sign-in"),
    play: async ({ canvas }) => {
        const email = await canvas.findByRole("textbox", undefined, PAGE_WAIT);

        await userEvent.type(email, "not-an-email");
        await userEvent.tab();

        await expect(await canvas.findByText("Invalid email format or aliasing not allowed", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** Without social providers or passkeys: the form alone, no divider. */
export const SignInEmailOnly: Story = {
    args: at({ path: "sign-in", route: SignInRoute }, "/auth/sign-in"),
    parameters: { msw: { handlers: { authMethods: signInMethodsHandlers({ passkey: false, social: [] }), lunora: lunoraHandlers() } } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Sign in" }, PAGE_WAIT)).toBeVisible();
    },
};

/** Registration is open, so the form is offered. */
export const SignUp: Story = {
    args: at({ path: "sign-up", route: SignUpRoute }, "/auth/sign-up"),
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Sign Up" }, PAGE_WAIT)).toBeVisible();
    },
};

/** Registration is by invitation and the visitor has none: the page says so and links to sign-in. */
export const SignUpNeedsInvitation: Story = {
    args: at({ path: "sign-up", route: SignUpRoute }, "/auth/sign-up"),
    parameters: { msw: { handlers: { authMethods: signInMethodsHandlers({ inviteOnly: true, passkey: false, social: [] }), lunora: lunoraHandlers() } } },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Sign-up needs an invitation", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const ForgotPassword: Story = {
    args: at({ path: "forgot-password", route: ForgotPasswordRoute }, "/auth/forgot-password"),
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Forgot Password" }, PAGE_WAIT)).toBeVisible();
    },
};

export const ResetPassword: Story = {
    args: at({ path: "reset-password", route: ResetPasswordRoute }, "/auth/reset-password?token=story-token"),
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Reset password" }, PAGE_WAIT)).toBeVisible();
    },
};

/** The story's auth provider has no second factor configured (the app's root turns it on); this one turns on the authenticator code. */
const WithTwoFactor = ({ children }: { children: ReactNode }) => {
    const { authClient } = useAuth();

    return (
        <AuthUIProviderTanstack authClient={authClient} navigate={() => undefined} persistClient={false} replace={() => undefined} twoFactor={["totp"]}>
            {children}
        </AuthUIProviderTanstack>
    );
};

export const TwoFactor: Story = {
    args: at({ path: "two-factor/", route: TwoFactorRoute }, "/auth/two-factor"),
    decorators: [
        (Story) => (
            <WithTwoFactor>
                <Story />
            </WithTwoFactor>
        ),
    ],
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("One-time password", undefined, PAGE_WAIT)).toBeVisible();
    },
};

export const RecoverAccount: Story = {
    args: at({ path: "recover-account", route: RecoverAccountRoute }, "/auth/recover-account"),
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Backup Code", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** A signed-in user opens the link from an invitation email. */
export const AcceptInvitation: Story = {
    args: {
        levels: [
            { path: "auth", route: AuthLayoutRoute },
            { path: "accept-invitation/$invitationId/", route: AcceptInvitationRoute },
        ],
        url: `/auth/accept-invitation/${INVITATION_ID}`,
    },
    parameters: { msw: { handlers: { authMethods: signInMethodsHandlers(), invitation: invitationHandlers(), lunora: lunoraHandlers() } }, persona: "free" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Accept" }, PAGE_WAIT)).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Reject" })).toBeVisible();
    },
};

/** `neore login --device` sends the user here to type the code the terminal shows. */
export const DeviceEnterCode: Story = {
    args: at({ path: "device", route: DeviceRoute }, "/auth/device"),
    parameters: { persona: "free" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("textbox", undefined, PAGE_WAIT)).toBeVisible();
        await expect(canvas.getByRole("heading", { name: "Approve a code" })).toBeVisible();
    },
};

/** The code names the computer asking; the user approves or denies. */
export const DeviceReview: Story = {
    args: at({ path: "device", route: DeviceRoute }, `/auth/device?user_code=${DEVICE_CODE}`),
    parameters: { msw: { handlers: { authMethods: signInMethodsHandlers(), device: deviceCodeHandlers(), lunora: lunoraHandlers() } }, persona: "free" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("ada-workstation", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** A code the server refuses. */
export const DeviceInvalidCode: Story = {
    args: at({ path: "device", route: DeviceRoute }, `/auth/device?user_code=${DEVICE_CODE}`),
    parameters: {
        msw: { handlers: { authMethods: signInMethodsHandlers(), device: deviceCodeHandlers("invalid"), lunora: lunoraHandlers() } },
        persona: "free",
    },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("alert", undefined, PAGE_WAIT)).toBeVisible();
    },
};

/** A guest who is signed in as an anonymous account is offered a permanent one. */
export const ConvertAccount: Story = {
    // The route sends a visitor away until the session says "guest", which the story cannot wait out; the component is the page.
    args: {
        levels: [
            { path: "auth", route: AuthLayoutRoute as AnyRoute },
            { component: () => <ConvertAnonymousAccount onSuccess={() => undefined} />, path: "convert-account" },
        ],
        url: "/auth/convert-account",
    },
    parameters: { persona: "guest" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Convert Account" }, PAGE_WAIT)).toBeVisible();
    },
};

/** The sign-in dialog the app opens over the page when a signed-out visitor needs an account. */
export const LoginDialog: Story = {
    args: { levels: [], overlay: () => <LoginModal onOpenChange={() => undefined} open />, url: "/chat" },
    play: async () => {
        await expect(await within(document.body).findByRole("button", { name: "Sign in" }, PAGE_WAIT)).toBeVisible();
    },
};
