import type { Meta, StoryObj } from "@storybook/react-vite";

/**
 * The design tokens of `packages/ui/src/global.css`, rendered from the live CSS variables, so
 * they follow the theme and accent toolbars (and run through axe in every CI mode).
 */
const meta = {
    parameters: { layout: "padded" },
    title: "Foundations",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The surface tokens and the text token the components put on them. The status and sidebar
 * tokens are not used as text-on-surface pairs (`text-destructive` sits on `bg-destructive/10`,
 * and `--sidebar-foreground` is mostly a background), so they are shown as swatches below.
 */
const PAIRS = [
    ["background", "foreground"],
    ["card", "card-foreground"],
    ["popover", "popover-foreground"],
    ["primary", "primary-foreground"],
    ["secondary", "secondary-foreground"],
    ["muted", "muted-foreground"],
    ["accent", "accent-foreground"],
] as const;

const SWATCHES = ["destructive", "success", "warning", "info", "sidebar", "sidebar-foreground", "border", "input", "ring", "primary-text"] as const;

const CHARTS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const;

export const Colors: Story = {
    render: () => (
        <div className="grid gap-8">
            <section aria-labelledby="surfaces">
                <h2 className="mb-3 text-sm font-semibold" id="surfaces">
                    Surfaces and their text
                </h2>
                <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    {PAIRS.map(([surface, text]) => (
                        <li className="overflow-hidden rounded-lg border" key={surface}>
                            <div className="p-4 text-sm" style={{ background: `var(--${surface})`, color: `var(--${text})` }}>
                                Aa — {surface}
                            </div>
                            <p className="text-muted-foreground px-3 py-2 font-mono text-xs">
                                --{surface} / --{text}
                            </p>
                        </li>
                    ))}
                </ul>
            </section>
            <section aria-labelledby="swatches">
                <h2 className="mb-3 text-sm font-semibold" id="swatches">
                    Status, sidebar and lines
                </h2>
                <ul className="flex flex-wrap gap-4">
                    {SWATCHES.map((token) => (
                        <li className="flex items-center gap-2" key={token}>
                            <span aria-hidden="true" className="size-8 rounded-md border" style={{ background: `var(--${token})` }} />
                            <span className="font-mono text-xs">--{token}</span>
                        </li>
                    ))}
                </ul>
                <p className="mt-3 text-sm" style={{ color: "var(--primary-text)" }}>
                    `--primary-text` is the accent as text, readable on the page background.
                </p>
            </section>
            <section aria-labelledby="charts">
                <h2 className="mb-3 text-sm font-semibold" id="charts">
                    Charts
                </h2>
                <ul className="flex gap-2">
                    {CHARTS.map((token) => (
                        <li className="grid justify-items-center gap-1" key={token}>
                            <span aria-hidden="true" className="h-10 w-16 rounded-md" style={{ background: `var(--${token})` }} />
                            <span className="font-mono text-xs">--{token}</span>
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    ),
};

const SIZES = ["text-xs", "text-sm", "text-base", "text-lg", "text-xl", "text-2xl", "text-3xl"] as const;

export const Typography: Story = {
    render: () => (
        <div className="grid gap-6">
            <ul className="grid gap-2">
                {SIZES.map((size) => (
                    <li className="flex items-baseline gap-4" key={size}>
                        <span className="text-muted-foreground w-24 font-mono text-xs">{size}</span>
                        <span className={size}>The quick brown fox jumps over the lazy dog</span>
                    </li>
                ))}
            </ul>
            <p className="font-mono text-sm">Geist Mono: const answer = await model.generate(prompt);</p>
            <p className="text-sm" style={{ fontFamily: "var(--font-pixel-square)" }}>
                Geist Pixel Square, used for display accents
            </p>
        </div>
    ),
};

const RADII = ["rounded-sm", "rounded-md", "rounded-lg", "rounded-xl", "rounded-full"] as const;

export const Radius: Story = {
    render: () => (
        <ul className="flex flex-wrap gap-4">
            {RADII.map((radius) => (
                <li className="grid justify-items-center gap-2" key={radius}>
                    <span aria-hidden="true" className={`bg-muted size-16 border ${radius}`} />
                    <span className="font-mono text-xs">{radius}</span>
                </li>
            ))}
        </ul>
    ),
};
