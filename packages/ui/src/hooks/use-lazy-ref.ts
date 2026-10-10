import * as React from "react";

const useLazyRef = <T>(function_: () => T): React.RefObject<T> => {
    const ref = React.useRef<T | null>(null);

    if (ref.current === null) {
        ref.current = function_();
    }

    return ref as React.RefObject<T>;
};

export { useLazyRef };
