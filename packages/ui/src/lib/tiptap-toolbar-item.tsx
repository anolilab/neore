/**
 * Names the icon-only button that reactjs-tiptap-editor renders for a toolbar item.
 * The library only shows the label in a hover tooltip and exposes no prop for an `aria-label`,
 * so the wrapper sets it on the item's own button and keeps it there if the library re-renders it.
 */

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

interface ToolbarItemProps {
    children: ReactNode;
    label: string;
}

export default function ToolbarItem({ children, label }: ToolbarItemProps) {
    const ref = useRef<HTMLSpanElement>(null);

    useEffect(() => {
        const element = ref.current;

        if (!element) {
            return undefined;
        }

        const apply = () => {
            const button = element.querySelector("button");

            if (!button) {
                return;
            }

            // A button with visible text (the heading picker shows the current level) must keep that text in its name.
            const text = button.textContent?.trim();
            const name = text ? `${label}: ${text}` : label;

            if (button.getAttribute("aria-label") !== name) {
                button.setAttribute("aria-label", name);
            }
        };

        apply();

        const observer = new MutationObserver(apply);

        observer.observe(element, { characterData: true, childList: true, subtree: true });

        return () => observer.disconnect();
    }, [label]);

    return (
        <span className="contents" ref={ref}>
            {children}
        </span>
    );
}
