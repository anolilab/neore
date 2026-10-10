import { CarouselContext } from "@ui/components/carousel-context";
import * as React from "react";

const useCarousel = () => {
    const context = React.use(CarouselContext);

    if (!context) {
        throw new Error("useCarousel must be used within a <Carousel />");
    }

    return context;
};

export { useCarousel };
