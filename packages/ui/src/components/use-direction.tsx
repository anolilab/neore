"use client";

import { useDirection as useBaseDirection } from "@base-ui/react/direction-provider";
import type { Direction } from "@ui/components/direction";

/**
 * Hook to get the current text direction.
 * Must be used within a DirectionProvider.
 * @example
 * ```tsx
 * function MyComponent() {
 *   const direction = useDirection();
 *   return <div>Current direction: {direction}</div>;
 * }
 * ```
 */
const useDirection = (): Direction => {
    const direction = useBaseDirection();

    return direction ?? "ltr";
};

export { useDirection };
