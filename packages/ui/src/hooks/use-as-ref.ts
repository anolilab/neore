import { useIsomorphicLayoutEffect } from "@ui/hooks/use-isomorphic-layout-effect";
import * as React from "react";

const useAsRef = <T>(props: T) => {
    const ref = React.useRef<T>(props);

    useIsomorphicLayoutEffect(() => {
        ref.current = props;
    });

    return ref;
};

export { useAsRef };
