import cn from "@ui/utils/cn";

const AspectRatio = ({ className, ratio, ...props }: React.ComponentProps<"div"> & { ratio: number }) => (
    <div
        className={cn("relative aspect-(--ratio)", className)}
        data-slot="aspect-ratio"
        style={
            {
                "--ratio": ratio,
            } as React.CSSProperties
        }
        {...props}
    />
);

export { AspectRatio };
