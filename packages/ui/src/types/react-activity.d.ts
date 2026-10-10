/**
 * React 19 Activity component type declarations.
 *
 * The Activity component is part of React 19's concurrent features but
 * is not yet included in `@types/react`.
 */
import type { ReactNode } from "react";

declare module "react" {
    interface ActivityProps {
        /**
         * The content to render inside the Activity.
         */
        children?: ReactNode;

        /**
         * The visibility mode of the Activity.
         * - "visible": The content is rendered and visible
         * - "hidden": The content is pre-rendered but hidden (maintains state)
         */
        mode: "visible" | "hidden";
    }

    /**
     * Activity component for managing visibility of pre-rendered content.
     *
     * Unlike conditional rendering, Activity maintains the state and DOM of
     * hidden content, making it useful for tab panels, modals, or other
     * content that needs to preserve state when hidden.
     */
    export const Activity: React.FC<ActivityProps>;
}
