"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import { formatNumber } from "@ui/utils/locale-format";
import * as React from "react";
import * as RechartsPrimitive from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";

// Format: { THEME_NAME: CSS_SELECTOR }
const THEMES = { dark: ".dark", light: "" } as const;

export type ChartConfig = {
    [k in string]: ({ color?: string; theme?: never } | { color?: never; theme: Record<keyof typeof THEMES, string> }) & {
        icon?: React.ComponentType;
        label?: React.ReactNode;
    };
};

type ChartContextProps = {
    config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextProps | null>(null);

const useChart = () => {
    const context = React.use(ChartContext);

    if (!context) {
        throw new Error("useChart must be used within a <ChartContainer />");
    }

    return context;
};

const ChartContainer = ({
    children,
    className,
    config,
    id,
    ...props
}: React.ComponentProps<"div"> & {
    children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
    config: ChartConfig;
}) => {
    const uniqueId = React.useId();
    const chartId = `chart-${id || uniqueId.replaceAll(":", "")}`;
    const contextValue = React.useMemo(() => {
        return { config };
    }, [config]);

    return (
        <ChartContext value={contextValue}>
            <div
                className={cn(
                    "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border flex aspect-video justify-center text-xs [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
                    className,
                )}
                data-chart={chartId}
                data-slot="chart"
                {...props}
            >
                <ChartStyle config={config} id={chartId} />
                <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
            </div>
        </ChartContext>
    );
};

const ChartStyle = ({ config, id }: { config: ChartConfig; id: string }) => {
    const colorConfig = Object.entries(config).filter(([, entryConfig]) => entryConfig.theme || entryConfig.color);

    if (colorConfig.length === 0) {
        return null;
    }

    // A text child rather than `dangerouslySetInnerHTML`: React treats `<style>`
    // as a raw-text element and emits its children verbatim, on the server too.
    const css = Object.entries(THEMES)
        .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
    .map(([key, itemConfig]) => {
        const color = itemConfig.theme?.[theme as keyof typeof itemConfig.theme] || itemConfig.color;

        return color ? `  --color-${key}: ${color};` : null;
    })
    .join("\n")}
}
`,
        )
        .join("\n");

    return <style>{css}</style>;
};

const ChartTooltip = RechartsPrimitive.Tooltip;

const ChartTooltipContent = ({
    active,
    className,
    color,
    formatter,
    hideIndicator = false,
    hideLabel = false,
    indicator = "dot",
    label,
    labelClassName,
    labelFormatter,
    labelKey,
    nameKey,
    payload,
}: Partial<RechartsPrimitive.TooltipContentProps<ValueType, NameType>> &
    React.ComponentProps<"div"> & {
        hideIndicator?: boolean;
        hideLabel?: boolean;
        indicator?: "line" | "dot" | "dashed";
        labelKey?: string;
        nameKey?: string;
    }) => {
    const { i18n } = useLingui();
    const { config } = useChart();

    const tooltipLabel = React.useMemo(() => {
        if (hideLabel || !payload?.length) {
            return null;
        }

        const [item] = payload;
        const key = String(labelKey || item?.dataKey || item?.name || "value");
        const itemConfig = getPayloadConfigFromPayload(config, item, key);
        const value = !labelKey && typeof label === "string" ? config[label as keyof typeof config]?.label || label : itemConfig?.label;

        if (labelFormatter) {
            return <div className={cn("font-medium", labelClassName)}>{labelFormatter(value, payload)}</div>;
        }

        if (!value) {
            return null;
        }

        return <div className={cn("font-medium", labelClassName)}>{value}</div>;
    }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey]);

    if (!active || !payload?.length) {
        return null;
    }

    const nestLabel = payload.length === 1 && indicator !== "dot";

    return (
        <div
            className={cn(
                "border-border/50 bg-background grid min-w-[8rem] items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs/relaxed shadow-xl",
                className,
            )}
        >
            {nestLabel ? null : tooltipLabel}
            <div className="grid gap-1.5">
                {payload
                    .filter((item) => item.type !== "none")
                    .map((item, index) => {
                        const key = String(nameKey || item.name || item.dataKey || "value");
                        const itemConfig = getPayloadConfigFromPayload(config, item, key);
                        const indicatorColor = color || item.payload.fill || item.color;

                        return (
                            <div
                                className={cn(
                                    "[&>svg]:text-muted-foreground flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5",
                                    indicator === "dot" && "items-center",
                                )}
                                key={key}
                            >
                                {formatter && item?.value !== undefined && item.name ? (
                                    formatter(item.value, item.name, item, index, item.payload)
                                ) : (
                                    <>
                                        {itemConfig?.icon ? (
                                            <itemConfig.icon />
                                        ) : (
                                            !hideIndicator && (
                                                <div
                                                    className={cn("shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)", {
                                                        "h-2.5 w-2.5": indicator === "dot",
                                                        "my-0.5": nestLabel && indicator === "dashed",
                                                        "w-0 border-[1.5px] border-dashed bg-transparent": indicator === "dashed",
                                                        "w-1": indicator === "line",
                                                    })}
                                                    style={
                                                        {
                                                            "--color-bg": indicatorColor,
                                                            "--color-border": indicatorColor,
                                                        } as React.CSSProperties
                                                    }
                                                />
                                            )
                                        )}
                                        <div className={cn("flex flex-1 justify-between leading-none", nestLabel ? "items-end" : "items-center")}>
                                            <div className="grid gap-1.5">
                                                {nestLabel ? tooltipLabel : null}
                                                <span className="text-muted-foreground">{itemConfig?.label || item.name}</span>
                                            </div>
                                            {item.value && (
                                                <span className="text-foreground font-mono font-medium tabular-nums">
                                                    {typeof item.value === "number" ? formatNumber(item.value, i18n.locale) : String(item.value)}
                                                </span>
                                            )}
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })}
            </div>
        </div>
    );
};

const ChartLegend = RechartsPrimitive.Legend;

const ChartLegendContent = ({
    className,
    hideIcon = false,
    nameKey,
    payload,
    verticalAlign = "bottom",
}: Pick<RechartsPrimitive.LegendProps, "verticalAlign"> &
    React.ComponentProps<"div"> & {
        hideIcon?: boolean;
        nameKey?: string;
        payload?: ReadonlyArray<RechartsPrimitive.LegendPayload>;
    }) => {
    const { config } = useChart();

    if (!payload?.length) {
        return null;
    }

    return (
        <div className={cn("flex items-center justify-center gap-4", verticalAlign === "top" ? "pb-3" : "pt-3", className)}>
            {payload
                .filter((item) => item.type !== "none")
                .map((item) => {
                    const key = String(nameKey || item.dataKey || "value");
                    const itemConfig = getPayloadConfigFromPayload(config, item, key);

                    return (
                        <div className={cn("[&>svg]:text-muted-foreground flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3")} key={item.value}>
                            {itemConfig?.icon && !hideIcon ? (
                                <itemConfig.icon />
                            ) : (
                                <div
                                    className="h-2 w-2 shrink-0 rounded-[2px]"
                                    style={{
                                        backgroundColor: item.color,
                                    }}
                                />
                            )}
                            {itemConfig?.label}
                        </div>
                    );
                })}
        </div>
    );
};

const getPayloadConfigFromPayload = (config: ChartConfig, payload: unknown, key: string) => {
    if (typeof payload !== "object" || payload === null) {
        return undefined;
    }

    const payloadPayload = "payload" in payload && typeof payload.payload === "object" && payload.payload !== null ? payload.payload : undefined;

    let configLabelKey: string = key;

    if (key in payload && typeof payload[key as keyof typeof payload] === "string") {
        configLabelKey = payload[key as keyof typeof payload] as string;
    } else if (payloadPayload && key in payloadPayload && typeof payloadPayload[key as keyof typeof payloadPayload] === "string") {
        configLabelKey = payloadPayload[key as keyof typeof payloadPayload] as string;
    }

    return config[configLabelKey in config ? configLabelKey : (key as keyof typeof config)];
};

export { ChartContainer, ChartLegend, ChartLegendContent, ChartStyle, ChartTooltip, ChartTooltipContent };
