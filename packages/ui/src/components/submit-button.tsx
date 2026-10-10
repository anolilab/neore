import cn from "../utils/cn";
import type { ButtonProps } from "./button";
import { Button } from "./button";
import { Spinner } from "./spinner";

const SubmitButton = ({
    children,
    disabled,
    isSubmitting,
    ...props
}: ButtonProps & {
    children: React.ReactNode;
    disabled?: boolean;
    isSubmitting: boolean;
}) => (
    <Button disabled={isSubmitting || disabled} {...props} className={cn(props.className, "relative")}>
        <span style={{ visibility: isSubmitting ? "hidden" : "visible" }}>{children}</span>
        {isSubmitting && (
            <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                <Spinner />
            </span>
        )}
    </Button>
);

export default SubmitButton;
