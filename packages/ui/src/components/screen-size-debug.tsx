import type { FC } from "react";

const screens = [
    { className: "2xl:block", name: "2xl" },
    { className: "xl:block 2xl:hidden", name: "xl" },
    { className: "lg:block xl:hidden", name: "lg" },
    { className: "md:block lg:hidden", name: "md" },
    { className: "sm:block md:hidden", name: "sm" },
    { className: "block sm:hidden", name: "xs" },
];

const ScreenSizeDebug: FC = () => {
    if (!(import.meta.env && import.meta.env.DEV)) {
        return null;
    }

    return (
        <div className="pointer-events-none fixed right-1 bottom-1 z-[9999] select-none">
            {screens.map((screen) => (
                <span className={`hidden ${screen.className} rounded bg-black/80 px-3 py-1 font-mono text-xs text-lime-300 shadow-lg`} key={screen.name}>
                    {screen.name}
                </span>
            ))}
        </div>
    );
};

export default ScreenSizeDebug;
