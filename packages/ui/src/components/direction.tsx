"use client";

import { DirectionProvider as BaseDirectionProvider } from "@base-ui/react/direction-provider";
import type * as React from "react";

export type Direction = "ltr" | "rtl";

interface DirectionProviderProps {
    children: React.ReactNode;

    /**
     * The text direction for the application
     * @default "ltr"
     */
    direction?: Direction;
}

/**
 * DirectionProvider sets the text direction (LTR or RTL) for your application.
 * This is essential for supporting right-to-left languages like Arabic, Hebrew, and Persian.
 * @example
 * ```tsx
 * <html dir="rtl">
 *   <body>
 *     <DirectionProvider direction="rtl">
 *       {/\* Your app content *\/}
 *     </DirectionProvider>
 *   </body>
 * </html>
 * ```
 */
const DirectionProvider: React.FC<DirectionProviderProps> = ({ children, direction = "ltr" }) => (
    <BaseDirectionProvider direction={direction}>{children}</BaseDirectionProvider>
);

export { DirectionProvider };
