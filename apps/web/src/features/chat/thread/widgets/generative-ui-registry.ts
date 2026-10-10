/**
 * Generative UI Registry
 *
 * Sets up the `@json-render/react` component registry using the
 * `@json-render/shadcn` preset. Only display-oriented components
 * are registered (no form inputs for security).
 *
 * Uses ComponentRegistry with explicit typing since we only need
 * rendering on the frontend (no catalog prompt generation).
 */
import type { ComponentRegistry } from "@json-render/react";
import { shadcnComponents } from "@json-render/shadcn";

/**
 * Registry of shadcn/ui components for rendering AI-generated specs.
 *
 * Security: Only display-oriented components are registered.
 * Form inputs (Input, Textarea, Select, etc.) and navigation
 * (Link, Button with actions) are intentionally excluded to
 * prevent user data collection or navigation attacks.
 *
 * The shadcn components accept BaseComponentProps which destructures
 * props from the element. We cast to ComponentRegistry since the
 * Renderer handles the element → props mapping internally.
 */
const generativeUIRegistry = {
    Accordion: shadcnComponents.Accordion,
    // Feedback
    Alert: shadcnComponents.Alert,
    // Visual
    Avatar: shadcnComponents.Avatar,
    Badge: shadcnComponents.Badge,

    // Layout
    Card: shadcnComponents.Card,
    Collapsible: shadcnComponents.Collapsible,

    Grid: shadcnComponents.Grid,
    // Typography
    Heading: shadcnComponents.Heading,

    Image: shadcnComponents.Image,
    Progress: shadcnComponents.Progress,

    Separator: shadcnComponents.Separator,
    Stack: shadcnComponents.Stack,
    // Data display
    Table: shadcnComponents.Table,

    // Interactive display (read-only)
    Tabs: shadcnComponents.Tabs,
    Text: shadcnComponents.Text,
    Tooltip: shadcnComponents.Tooltip,
} as unknown as ComponentRegistry;

export default generativeUIRegistry;
