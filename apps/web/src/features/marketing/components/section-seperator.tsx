import type { FC } from "react";

const SectionSeperator: FC<{ hideBottom?: boolean; hideTop?: boolean }> = ({ hideBottom = false, hideTop = false }) => (
    <>
        {hideTop ? null : (
            <>
                <div
                    aria-hidden="true"
                    className="border-brand-chartreuse pointer-events-none absolute top-0 left-0 -mt-px -ml-[0.5px] h-3 w-3 border-t border-l"
                />
                <div
                    aria-hidden="true"
                    className="border-brand-chartreuse pointer-events-none absolute top-0 right-0 -mt-px -mr-[0.5px] h-3 w-3 border-t border-r"
                />
            </>
        )}
        {hideBottom ? null : (
            <>
                <div
                    aria-hidden="true"
                    className="border-brand-chartreuse pointer-events-none absolute bottom-0 left-0 -mt-px -ml-[0.5px] h-3 w-3 border-b border-l"
                />
                <div
                    aria-hidden="true"
                    className="border-brand-chartreuse pointer-events-none absolute right-0 bottom-0 -mt-px -mr-[0.5px] h-3 w-3 border-r border-b"
                />
            </>
        )}
    </>
);

export default SectionSeperator;
