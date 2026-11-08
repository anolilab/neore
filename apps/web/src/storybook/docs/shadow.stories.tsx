import type { Meta, StoryObj } from "@storybook/react-vite";

/** The elevation scale: which surface sits on which shadow. Decorative, so each shape carries its name as text. */
const meta = {
    parameters: { layout: "padded" },
    title: "Foundations/Shadow",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Full class names, so Tailwind finds them in the source.
const SHADOWS = ["shadow-xs", "shadow-sm", "shadow", "shadow-md", "shadow-lg", "shadow-xl"] as const;

export const Elevations: Story = {
    render: () => (
        <ul className="flex flex-wrap gap-8 p-4">
            {SHADOWS.map((shadow) => (
                <li className="grid justify-items-center gap-3" key={shadow}>
                    <span className={`bg-card size-24 rounded-lg ${shadow}`} />
                    <span className="font-mono text-xs">{shadow}</span>
                </li>
            ))}
            <li className="grid justify-items-center gap-3">
                <span className="bg-card size-24 rounded-lg" style={{ boxShadow: "var(--shadow-complex)" }} />
                <span className="font-mono text-xs">--shadow-complex</span>
            </li>
        </ul>
    ),
};
