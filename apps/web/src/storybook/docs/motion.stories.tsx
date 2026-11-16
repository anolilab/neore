import type { Meta, StoryObj } from "@storybook/react-vite";

/**
 * The motion the components use. `packages/ui/src/global.css` shortens every animation to
 * almost nothing under `prefers-reduced-motion`, so these keep their meaning without the movement.
 */
const meta = {
    parameters: { layout: "padded" },
    title: "Foundations/Motion",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Animations: Story = {
    render: () => (
        <ul className="grid gap-6">
            <li className="flex items-center gap-4">
                <span aria-hidden="true" className="border-primary size-6 animate-spin rounded-full border-2 border-t-transparent" />
                <span className="text-sm">
                    <code className="font-mono text-xs">animate-spin</code> — a spinner while work is in progress
                </span>
            </li>
            <li className="flex items-center gap-4">
                <span aria-hidden="true" className="bg-primary size-3 animate-pulse rounded-full" />
                <span className="text-sm">
                    <code className="font-mono text-xs">animate-pulse</code> — a placeholder that is still loading
                </span>
            </li>
            <li className="flex items-center gap-4">
                <span aria-hidden="true" className="bg-primary size-3 animate-bounce rounded-full" />
                <span className="text-sm">
                    <code className="font-mono text-xs">animate-bounce</code> — an attention cue, used sparingly
                </span>
            </li>
            <li className="flex items-center gap-4">
                <span aria-hidden="true" className="bg-card size-6 rounded-md border transition-transform duration-200 hover:translate-x-4" />
                <span className="text-sm">
                    <code className="font-mono text-xs">transition-transform duration-200</code> — hover feedback, 200 ms
                </span>
            </li>
        </ul>
    ),
};
