import type { Meta, StoryObj } from "@storybook/react-vite";

/** The spacing scale of Tailwind as this app uses it: the same numbers for padding, gaps and margins. */
const meta = {
    parameters: { layout: "padded" },
    title: "Foundations/Spacing",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Full class names, so Tailwind finds them in the source.
const STEPS = [
    { label: "0.5", width: "w-0.5" },
    { label: "1", width: "w-1" },
    { label: "2", width: "w-2" },
    { label: "3", width: "w-3" },
    { label: "4", width: "w-4" },
    { label: "6", width: "w-6" },
    { label: "8", width: "w-8" },
    { label: "12", width: "w-12" },
    { label: "16", width: "w-16" },
    { label: "24", width: "w-24" },
] as const;

export const Scale: Story = {
    render: () => (
        <ul className="grid gap-2">
            {STEPS.map((step) => (
                <li className="flex items-center gap-4" key={step.label}>
                    <span className="text-muted-foreground w-10 font-mono text-xs">{step.label}</span>
                    <span aria-hidden="true" className={`bg-primary h-4 rounded-sm ${step.width}`} />
                    <span className="text-muted-foreground font-mono text-xs">{`${Number(step.label) * 0.25}rem`}</span>
                </li>
            ))}
        </ul>
    ),
};

/** A card with the spacing a component uses between its parts: `gap-2` between items, `p-4` inside the surface. */
export const InUse: Story = {
    render: () => (
        <section aria-labelledby="spacing-in-use" className="bg-card text-card-foreground w-80 rounded-lg border p-4">
            <h2 className="text-sm font-semibold" id="spacing-in-use">
                Card title
            </h2>
            <div className="mt-2 grid gap-2">
                <p className="text-muted-foreground text-sm">Gap 2 between the parts, padding 4 around them.</p>
                <p className="text-muted-foreground text-sm">Gap 2 between the paragraphs.</p>
            </div>
        </section>
    ),
};
