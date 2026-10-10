/**
 * Render UI Tool
 * Allows the AI to compose rich interactive widgets inline in chat
 * by outputting structured JSON specs that render as React components
 * via `@json-render/react` on the frontend.
 *
 * The tool validates the spec structure and passes it through — all
 * rendering happens on the client side using the json-render catalog.
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { toolsLogger } from "../../lib/logger";

/**
 * Maximum nesting depth allowed in spec elements.
 * Prevents abuse or accidental deep recursion.
 */
const MAX_ELEMENT_COUNT = 60;

/**
 * Allowed component types that map to the frontend catalog.
 * Reject anything not in this list to prevent arbitrary component injection.
 */
const ALLOWED_COMPONENT_TYPES = new Set([
    "Accordion",
    "Alert",
    "Avatar",
    "Badge",
    "Card",
    "Collapsible",
    "Grid",
    "Heading",
    "Image",
    "Progress",
    "Separator",
    "Stack",
    "Table",
    "Tabs",
    "Text",
    "Tooltip",
]);

/**
 * Zod schema for a single UI element in the flat spec format.
 * Matches the `@json-render/core` UIElement structure.
 */
const UIElementSchema = z.object({
    children: z.array(z.string()).optional().meta({ description: "Child element keys (references into the elements map)" }),
    props: z.record(z.string(), z.unknown()).meta({ description: "Component props matching the catalog definition" }),
    type: z.string().meta({
        description: "Component type from the catalog (e.g. Card, Table, Heading, Text, Grid, Stack, Badge, Alert, Progress, Tabs, Accordion, Separator)",
    }),
});

/**
 * Zod schema for the full spec — the flat element tree format
 * used by `@json-render/core.`
 */
const SpecSchema = z.object({
    elements: z.record(z.string(), UIElementSchema).meta({ description: "Flat map of element key → UIElement" }),
    root: z.string().meta({ description: "Key of the root element in the elements map" }),
    state: z.record(z.string(), z.unknown()).optional().meta({ description: "Optional initial state for dynamic values" }),
});

/**
 * Output type for the renderUI tool
 */
export interface RenderUIOutput {
    _type: "generative-ui";
    spec: {
        elements: Record<string, { children?: string[]; props: Record<string, unknown>; type: string }>;
        root: string;
        state?: Record<string, unknown>;
    };
    title?: string;
}

/**
 * renderUI Tool
 *
 * Outputs a JSON spec describing a layout composed from a curated set
 * of UI primitives. The frontend renders these specs into real React
 * components using `@json-render/react` with shadcn/ui components.
 */
const renderUITool = createTool<
    {
        spec: {
            elements: Record<string, { children?: string[]; props: Record<string, unknown>; type: string }>;
            root: string;
            state?: Record<string, unknown>;
        };
        title?: string;
    },
    RenderUIOutput,
    ToolContext
>({
    description: `Render a rich interactive UI widget inline in the chat message. Use this when the user's question is best answered with structured visual content rather than plain text or markdown.

WHEN TO USE:
- Comparison tables (frameworks, products, plans)
- Metric dashboards with KPI values and changes
- Step-by-step guides or timelines
- Data summaries with labeled sections
- Pro/con lists or feature comparisons
- Status overviews with progress indicators

WHEN NOT TO USE:
- Simple text answers
- Code snippets (use markdown code blocks)
- Single values or short lists (use markdown)

SPEC FORMAT (flat element tree):
The spec uses a flat map of elements referenced by key. Each element has a \`type\` (component name) and \`props\`.

Available component types:
- Card: Container with title, description, maxWidth (sm/md/lg/full), centered
- Stack: Flex layout with direction (horizontal/vertical), gap (sm/md/lg/none), align, justify
- Grid: Grid layout with columns (number), gap (sm/md/lg)
- Table: Data table with columns (string[]), rows (string[][]), caption
- Heading: Text heading with text, level (h1/h2/h3/h4)
- Text: Body text with text, variant (caption/body/muted/lead/code)
- Badge: Label badge with text, variant (default/secondary/destructive/outline)
- Alert: Alert box with title, message, type (success/info/warning/error)
- Progress: Progress bar with value (0-100), max, label
- Tabs: Tab container with tabs [{label, value}], defaultValue — children map to tab values
- Accordion: Collapsible sections with items [{title, content}]
- Separator: Visual divider with orientation (horizontal/vertical)
- Collapsible: Expandable section with title, defaultOpen — slot for content children

EXAMPLE - Comparison Table:
{
  "root": "main",
  "elements": {
    "main": { "type": "Stack", "props": { "direction": "vertical", "gap": "md" }, "children": ["heading", "table"] },
    "heading": { "type": "Heading", "props": { "text": "Framework Comparison", "level": "h3" } },
    "table": { "type": "Table", "props": { "columns": ["Feature", "React", "Vue", "Svelte"], "rows": [["Learning Curve", "Moderate", "Easy", "Easy"], ["Bundle Size", "42KB", "33KB", "1.6KB"]] } }
  }
}

EXAMPLE - Metric Dashboard:
{
  "root": "grid",
  "elements": {
    "grid": { "type": "Grid", "props": { "columns": 3, "gap": "md" }, "children": ["m1", "m2", "m3"] },
    "m1": { "type": "Card", "props": { "title": "Revenue", "description": "$1.2M (+12.5%)" } },
    "m2": { "type": "Card", "props": { "title": "Users", "description": "45,231 (+8.3%)" } },
    "m3": { "type": "Card", "props": { "title": "Churn", "description": "2.1% (-0.3%)" } }
  }
}`,
    execute: async (context, input) => {
        if (!context.userId) {
            throw new Error("Authentication required");
        }

        const { spec, title } = input;

        // Validate element count to prevent abuse
        const elementCount = Object.keys(spec.elements).length;

        if (elementCount > MAX_ELEMENT_COUNT) {
            toolsLogger.warn(`[renderUI] Spec has ${elementCount} elements, exceeding max of ${MAX_ELEMENT_COUNT}`);
            throw new Error(`Spec has too many elements (${elementCount}). Maximum is ${MAX_ELEMENT_COUNT}.`);
        }

        // Validate root exists in elements
        if (!Object.hasOwn(spec.elements, spec.root)) {
            toolsLogger.warn(`[renderUI] Root element "${spec.root}" not found in elements map`);
            throw new Error(`Root element "${spec.root}" not found in elements map.`);
        }

        // Validate component types against allowlist
        for (const [key, element] of Object.entries(spec.elements)) {
            if (!ALLOWED_COMPONENT_TYPES.has(element.type)) {
                toolsLogger.warn(`[renderUI] Element "${key}" has disallowed type "${element.type}"`);
                throw new Error(`Element "${key}" uses disallowed component type "${element.type}". Allowed: ${[...ALLOWED_COMPONENT_TYPES].join(", ")}.`);
            }
        }

        // Validate all child references exist
        for (const [key, element] of Object.entries(spec.elements)) {
            if (element.children) {
                for (const childKey of element.children) {
                    if (!Object.hasOwn(spec.elements, childKey)) {
                        toolsLogger.warn(`[renderUI] Element "${key}" references missing child "${childKey}"`);
                        throw new Error(`Element "${key}" references missing child "${childKey}".`);
                    }
                }
            }
        }

        // Cycle detection — without this, the frontend renderer walks
        // children recursively and can blow the stack / hang the tab.
        const detectCycle = (key: string, path: Set<string>): string[] | null => {
            if (path.has(key)) {
                return [...path, key];
            }

            const element = spec.elements[key];

            if (!element?.children) return null;

            const next = new Set(path);

            next.add(key);

            for (const childKey of element.children) {
                const cycle = detectCycle(childKey, next);

                if (cycle) return cycle;
            }

            return null;
        };
        const cycle = detectCycle(spec.root, new Set());

        if (cycle) {
            toolsLogger.warn(`[renderUI] Cycle detected in element children: ${cycle.join(" -> ")}`);
            throw new Error(`Cycle detected in element children: ${cycle.join(" -> ")}`);
        }

        toolsLogger.debug(`[renderUI] Valid spec with ${elementCount} elements, root="${spec.root}"`);

        return {
            _type: "generative-ui" as const,
            spec,
            title,
        };
    },
    inputSchema: z.object({
        spec: SpecSchema.describe("The UI layout specification in flat element tree format"),
        title: z.string().max(100).optional().meta({ description: "Optional title shown above the widget" }),
    }),
    title: "Render UI",
});

export default renderUITool;
