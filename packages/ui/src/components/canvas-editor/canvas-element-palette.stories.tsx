import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Canvas } from "fabric";
import { useEffect, useRef, useState } from "react";
import { expect } from "storybook/test";

import CanvasElementPalette from "./canvas-element-palette";

interface HarnessProps {
    darkMode?: boolean;
    /** Render the palette before the canvas exists. */
    withoutCanvas?: boolean;
}

const Harness = ({ darkMode, withoutCanvas = false }: HarnessProps) => {
    const elementRef = useRef<HTMLCanvasElement>(null);
    const [canvas, setCanvas] = useState<Canvas | null>(null);

    useEffect(() => {
        let created: Canvas | null = null;
        let cancelled = false;

        const init = async () => {
            const { Canvas: FabricCanvas } = await import("fabric");

            if (cancelled || !elementRef.current) {
                return;
            }

            created = new FabricCanvas(elementRef.current, { height: 200, width: 300 });
            setCanvas(created);
        };

        init();

        return () => {
            cancelled = true;
            created?.dispose();
        };
    }, []);

    return (
        <div className="flex gap-4">
            <div className={darkMode ? "dark bg-background w-72 rounded-md border p-2" : "w-72 rounded-md border p-2"}>
                <CanvasElementPalette canvas={withoutCanvas ? null : canvas} darkMode={darkMode} />
            </div>
            <canvas ref={elementRef} />
        </div>
    );
};

const meta = {
    component: Harness,
    title: "UI/Editors/Canvas element palette",
} satisfies Meta<typeof Harness>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByRole("button", { name: "Add Rectangle" })).toBeVisible();
    },
};

export const DarkMode: Story = {
    args: { darkMode: true },
};

export const WithoutCanvas: Story = {
    args: { withoutCanvas: true },
};
