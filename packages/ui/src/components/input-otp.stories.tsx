import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent } from "storybook/test";

import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "./input-otp";

interface OtpProps {
    defaultValue?: string;
    disabled?: boolean;
    onChange?: (value: string) => void;
}

const Otp = ({ defaultValue, disabled, onChange }: OtpProps) => (
    <InputOTP aria-label="Verification code" defaultValue={defaultValue} disabled={disabled} maxLength={6} onChange={onChange}>
        <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
            <InputOTPSlot index={2} />
        </InputOTPGroup>
        <InputOTPSeparator />
        <InputOTPGroup>
            <InputOTPSlot index={3} />
            <InputOTPSlot index={4} />
            <InputOTPSlot index={5} />
        </InputOTPGroup>
    </InputOTP>
);

const meta = {
    args: { onChange: fn() },
    component: Otp,
    title: "UI/InputOTP",
} satisfies Meta<typeof Otp>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Empty: Story = {
    play: async ({ args, canvas }) => {
        const input = canvas.getByRole("textbox", { name: "Verification code" });

        await userEvent.type(input, "123456");
        await expect(input).toHaveValue("123456");
        await expect(args.onChange).toHaveBeenCalled();
    },
};

export const PartiallyFilled: Story = { args: { defaultValue: "123" } };

export const Complete: Story = { args: { defaultValue: "123456" } };

export const Disabled: Story = { args: { defaultValue: "12", disabled: true } };
