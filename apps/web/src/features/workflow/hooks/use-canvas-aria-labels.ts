import { useLingui } from "@lingui/react/macro";
import type { AriaLabelConfig } from "@xyflow/react";
import { useMemo } from "react";

/**
 * React Flow's own screen-reader strings, localized. Typing the result as the full
 * AriaLabelConfig makes a key missing from this list a compile error.
 */
export const useCanvasAriaLabels = (): AriaLabelConfig => {
    const { i18n, t } = useLingui();

    return useMemo<AriaLabelConfig>(() => {
        // React Flow passes the arrow key name, lower-cased, as `direction`.
        const directions: Record<string, string> = {
            down: t`down`,
            left: t`left`,
            right: t`right`,
            up: t`up`,
        };

        return {
            "controls.ariaLabel": t`Control panel`,
            "controls.fitView.ariaLabel": t`Fit view`,
            "controls.interactive.ariaLabel": t`Toggle interactivity`,
            "controls.zoomIn.ariaLabel": t`Zoom in`,
            "controls.zoomOut.ariaLabel": t`Zoom out`,
            "edge.a11yDescription.default": t`Press enter or space to select an edge. You can then press delete to remove it or escape to cancel.`,
            "handle.ariaLabel": t`Handle`,
            "minimap.ariaLabel": t`Mini map`,
            "node.a11yDescription.default": t`Press enter or space to select a node. Press delete to remove it and escape to cancel.`,
            "node.a11yDescription.keyboardDisabled": t`Press enter or space to select a node. You can then use the arrow keys to move the node around. Press delete to remove it and escape to cancel.`,
            "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }) =>
                t`Moved selected node ${directions[direction] ?? direction}. New position, x: ${x}, y: ${y}`,
        };
    }, [i18n.locale, t]);
};
