import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor } from "storybook/test";

import LoginForm from "./login-form";

const meta: Meta<typeof LoginForm> = {
    args: { onSignIn: fn(async () => {}) },
    component: LoginForm,
    decorators: [
        (Story) => (
            <div className="w-80">
                <Story />
            </div>
        ),
    ],
    title: "Chat/LoginForm",
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ args, canvas }) => {
        await userEvent.type(canvas.getByLabelText("Email"), "ada@example.com");
        await userEvent.type(canvas.getByLabelText("Password"), "correct horse");
        await userEvent.click(canvas.getByRole("button", { name: "Sign In" }));
        await waitFor(() => expect(args.onSignIn).toHaveBeenCalledWith("ada@example.com", "correct horse"));
    },
};

/** Sign in stays disabled until both fields are filled. */
export const EmptySubmit: Story = {
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("button", { name: "Sign In" })).toBeDisabled();
    },
};

export const WithGoogle: Story = {
    args: { onSignInWithGoogle: fn() },
    play: async ({ args, canvas }) => {
        await userEvent.click(canvas.getByRole("button", { name: "Continue with Google" }));
        await expect(args.onSignInWithGoogle).toHaveBeenCalledOnce();
    },
};

export const WithError: Story = {
    args: { error: "Wrong email or password." },
    play: async ({ canvas }) => {
        await expect(canvas.getByRole("alert")).toHaveTextContent("Wrong email or password.");
    },
};

export const Loading: Story = {
    args: { isLoading: true },
    play: async ({ canvas }) => {
        await expect(canvas.getByLabelText("Email")).toBeDisabled();
    },
};

export const PasswordRevealed: Story = {
    play: async ({ canvas }) => {
        await userEvent.type(canvas.getByLabelText("Password"), "secret");
        await userEvent.click(canvas.getByRole("button", { name: "Show password" }));
        await expect(canvas.getByLabelText("Password")).toHaveAttribute("type", "text");
    },
};
