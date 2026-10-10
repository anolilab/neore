/**
 * Generative UI Widget
 *
 * Renders AI-composed JSON specs as real React components using
 * `@json-render/react` with the `@json-render/shadcn` component preset.
 *
 * The AI tool `renderUI` outputs a flat element tree spec, and this
 * widget renders it inline in the chat message stream.
 */
import type { Spec } from "@json-render/core";
import { Renderer } from "@json-render/react";
import type { FC } from "react";

import generativeUIRegistry from "./generative-ui-registry";

interface RenderUIOutput {
    _type: "generative-ui";
    spec: Spec;
    title?: string;
}

interface GenerativeUIWidgetProps {
    output: unknown;
}

const GenerativeUIWidget: FC<GenerativeUIWidgetProps> = ({ output }) => {
    const data = output as RenderUIOutput;

    // Validate that we have the expected output shape:
    // a root element that actually exists in the element map.
    const spec = data?.spec?.root && data.spec.elements && Object.hasOwn(data.spec.elements, data.spec.root) ? data.spec : null;

    if (!spec) {
        return null;
    }

    return (
        <div className="border-border/50 bg-card my-3 overflow-hidden rounded-xl border p-4 shadow-sm">
            {data.title && <h3 className="text-foreground mb-3 text-sm font-semibold">{data.title}</h3>}
            <Renderer registry={generativeUIRegistry} spec={spec} />
        </div>
    );
};

export default GenerativeUIWidget;
