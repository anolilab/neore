import cn from "@ui/utils/cn";
import { OTPInput, OTPInputContext } from "input-otp";
import { MinusIcon } from "lucide-react";
import * as React from "react";

const InputOTP = ({
    className,
    containerClassName,
    ...props
}: React.ComponentProps<typeof OTPInput> & {
    containerClassName?: string;
}) => (
    <OTPInput
        className={cn("disabled:cursor-not-allowed", className)}
        containerClassName={cn("cn-input-otp flex items-center has-disabled:opacity-50", containerClassName)}
        data-slot="input-otp"
        spellCheck={false}
        {...props}
    />
);

const InputOTPGroup = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn(
            "has-aria-invalid:ring-destructive/20 dark:has-aria-invalid:ring-destructive/40 has-aria-invalid:border-destructive flex items-center rounded-md has-aria-invalid:ring-[2px]",
            className,
        )}
        data-slot="input-otp-group"
        {...props}
    />
);

const InputOTPSlot = ({
    className,
    index,
    ...props
}: React.ComponentProps<"div"> & {
    index: number;
}) => {
    const inputOTPContext = React.use(OTPInputContext);
    const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {};

    return (
        <div
            className={cn(
                "bg-input/20 dark:bg-input/30 border-input data-[active=true]:border-ring data-[active=true]:ring-ring/30 data-[active=true]:aria-invalid:ring-destructive/20 dark:data-[active=true]:aria-invalid:ring-destructive/40 aria-invalid:border-destructive data-[active=true]:aria-invalid:border-destructive relative flex size-7 items-center justify-center border-y border-r text-xs/relaxed transition-all outline-none first:rounded-l-md first:border-l last:rounded-r-md data-[active=true]:z-10 data-[active=true]:ring-[2px]",
                className,
            )}
            data-active={isActive}
            data-slot="input-otp-slot"
            {...props}
        >
            {char}
            {hasFakeCaret && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <div className="animate-caret-blink bg-foreground bg-foreground h-4 w-px duration-1000" />
                </div>
            )}
        </div>
    );
};

const InputOTPSeparator = ({ ...props }: React.ComponentProps<"div">) => (
    <div className="flex items-center [&_svg:not([class*='size-'])]:size-4" data-slot="input-otp-separator" role="separator" {...props}>
        <MinusIcon />
    </div>
);

export { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot };
