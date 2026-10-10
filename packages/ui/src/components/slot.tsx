import { useRender } from "@base-ui/react/use-render";
import type * as React from "react";

export interface SlotProps extends React.HTMLAttributes<HTMLElement> {
    ref?: React.Ref<HTMLElement>;
    render?: React.ReactElement;
}

const Slot = ({ children, ref, render, ...props }: SlotProps) =>
    useRender({
        defaultTagName: "div",
        props: { ...props, children, ref },
        render,
    });

Slot.displayName = "Slot";

export default Slot;
