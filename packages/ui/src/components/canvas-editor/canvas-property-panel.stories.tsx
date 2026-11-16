import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Canvas } from "fabric";
import { useEffect, useRef, useState } from "react";
import { expect } from "storybook/test";

import CanvasPropertyPanel from "./canvas-property-panel";

interface HarnessProps {
    darkMode?: boolean;
    /** Add a rectangle and select it once the canvas is ready. */
    selectShape?: boolean;
}

const Harness = ({ darkMode, selectShape = false }: HarnessProps) => {
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

    // Runs after the panel's own effect (children first), so the panel sees the selection event.
    useEffect(() => {
        if (!canvas || !selectShape) {
            return;
        }

        const add = async () => {
            const { Rect } = await import("fabric");
            const rect = new Rect({ fill: "#3b82f6", height: 80, left: 40, top: 40, width: 120 });

            canvas.add(rect);
            canvas.setActiveObject(rect);
            canvas.requestRenderAll();
        };

        add();
    }, [canvas, selectShape]);

    return (
        <div className="flex gap-4">
            <div className={darkMode ? "dark bg-background w-72 rounded-md border p-2" : "w-72 rounded-md border p-2"}>
                <CanvasPropertyPanel canvas={canvas} darkMode={darkMode} />
            </div>
            <canvas ref={elementRef} />
        </div>
    );
};

const meta = {
    component: Harness,
    title: "UI/Editors/Canvas property panel",
} satisfies Meta<typeof Harness>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NothingSelected: Story = {
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Select an object to edit its properties")).toBeVisible();
    },
};

export const ShapeSelected: Story = {
    args: { selectShape: true },
};

export const ShapeSelectedDark: Story = {
    args: { darkMode: true, selectShape: true },
};
