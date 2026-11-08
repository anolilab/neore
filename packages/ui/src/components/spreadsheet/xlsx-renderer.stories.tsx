import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import { expect } from "storybook/test";

import type { XlsxRendererProps } from "./xlsx-renderer";
import { XlsxRenderer } from "./xlsx-renderer";

const SHEETS: Record<string, (string | number)[][]> = {
    Customers: [
        ["Name", "City"],
        ["Ada", "Berlin"],
        ["Grace", "Lisbon"],
    ],
    Orders: [
        ["Order", "Customer", "Total"],
        [1001, "Ada", 120.5],
        [1002, "Grace", 89],
        [1003, "Linus", 240.25],
    ],
};

const buildWorkbook = async (sheetNames: string[]): Promise<ArrayBuffer> => {
    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();

    for (const name of sheetNames) {
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(SHEETS[name] ?? []), name);
    }

    return XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
};

const DEFAULT_SHEETS = ["Orders"];

interface HarnessProps extends Omit<XlsxRendererProps, "source"> {
    invalidBytes?: boolean;
    /** Sheets to put in the generated workbook; ignored when `invalidBytes` is set. */
    sheetNames?: string[];
}

const Harness = ({ invalidBytes = false, sheetNames = DEFAULT_SHEETS, ...props }: HarnessProps) => {
    const [source, setSource] = useState<ArrayBuffer | null>(null);

    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            const buffer = invalidBytes ? new TextEncoder().encode("this is not a workbook").buffer : await buildWorkbook(sheetNames);

            if (!cancelled) {
                setSource(buffer as ArrayBuffer);
            }
        };

        load();

        return () => {
            cancelled = true;
        };
    }, [invalidBytes, sheetNames]);

    return source ? <XlsxRenderer {...props} source={source} /> : null;
};

const meta = {
    component: Harness,
    title: "UI/Files/XLSX renderer",
} satisfies Meta<typeof Harness>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    args: { fileName: "orders.xlsx" },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Grace", undefined, { timeout: 10_000 })).toBeVisible();
    },
};

export const MultipleSheets: Story = {
    args: { fileName: "report.xlsx", sheetNames: ["Orders", "Customers"] },
    play: async ({ canvas }) => {
        await expect(await canvas.findByText("Linus", undefined, { timeout: 10_000 })).toBeVisible();
    },
};

export const InvalidFile: Story = {
    args: { fileName: "broken.xlsx", invalidBytes: true },
};
