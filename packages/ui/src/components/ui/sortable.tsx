"use client";

import type {
    Announcements,
    DndContextProps,
    DragEndEvent,
    DraggableAttributes,
    DraggableSyntheticListeners,
    DragStartEvent,
    DropAnimation,
    ScreenReaderInstructions,
    UniqueIdentifier,
} from "@dnd-kit/core";
import {
    closestCenter,
    closestCorners,
    defaultDropAnimationSideEffects,
    DndContext,
    DragOverlay,
    KeyboardSensor,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
} from "@dnd-kit/core";
import { restrictToHorizontalAxis, restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import type { SortableContextProps } from "@dnd-kit/sortable";
import {
    arrayMove,
    horizontalListSortingStrategy,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import Slot from "@ui/components/slot";
import { useComposedRefs } from "@ui/lib/compose-refs";
import cn from "@ui/utils/cn";
import * as React from "react";
import * as ReactDOM from "react-dom";

const orientationConfig = {
    horizontal: {
        collisionDetection: closestCenter,
        modifiers: [restrictToHorizontalAxis, restrictToParentElement],
        strategy: horizontalListSortingStrategy,
    },
    mixed: {
        collisionDetection: closestCorners,
        modifiers: [restrictToParentElement],
        strategy: undefined,
    },
    vertical: {
        collisionDetection: closestCenter,
        modifiers: [restrictToVerticalAxis, restrictToParentElement],
        strategy: verticalListSortingStrategy,
    },
};

const ROOT_NAME = "Sortable";
const CONTENT_NAME = "SortableContent";
const ITEM_NAME = "SortableItem";
const ITEM_HANDLE_NAME = "SortableItemHandle";
const OVERLAY_NAME = "SortableOverlay";

interface SortableRootContextValue<T> {
    activeId: UniqueIdentifier | null;
    flatCursor: boolean;
    getItemValue: (item: T) => UniqueIdentifier;
    id: string;
    items: UniqueIdentifier[];
    modifiers: DndContextProps["modifiers"];
    setActiveId: (id: UniqueIdentifier | null) => void;
    strategy: SortableContextProps["strategy"];
}

const SortableRootContext = React.createContext<SortableRootContextValue<unknown> | null>(null);

const useSortableContext = (consumerName: string) => {
    const context = React.use(SortableRootContext);

    if (!context) {
        throw new Error(`\`${consumerName}\` must be used within \`${ROOT_NAME}\``);
    }

    return context;
};

interface GetItemValue<T> {
    /**
     * Callback that returns a unique identifier for each sortable item. Required for array of objects.
     * @example getItemValue={(item) => item.id}
     */
    getItemValue: (item: T) => UniqueIdentifier;
}

type SortableRootProps<T> = DndContextProps &
    (T extends object ? GetItemValue<T> : Partial<GetItemValue<T>>) & {
        flatCursor?: boolean;
        onMove?: (event: DragEndEvent & { activeIndex: number; overIndex: number }) => void;
        onValueChange?: (items: T[]) => void;
        orientation?: "vertical" | "horizontal" | "mixed";
        strategy?: SortableContextProps["strategy"];
        value: T[];
    };

const getMoveKeysLabel = (orientation: "vertical" | "horizontal" | "mixed"): string => {
    if (orientation === "vertical") {
        return "up and down";
    }

    return orientation === "horizontal" ? "left and right" : "arrow";
};

const SortableRoot = <T,>(props: SortableRootProps<T>) => {
    const {
        accessibility,
        collisionDetection,
        flatCursor = false,
        getItemValue: getItemValueProp,
        modifiers,
        onDragCancel: onDragCancelProp,
        onDragEnd: onDragEndProp,
        onDragStart: onDragStartProp,
        onMove,
        onValueChange,
        orientation = "vertical",
        strategy,
        value,
        ...sortableProps
    } = props;

    const id = React.useId();
    const [activeId, setActiveId] = React.useState<UniqueIdentifier | null>(null);

    const sensors = useSensors(
        useSensor(MouseSensor),
        useSensor(TouchSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        }),
    );
    const config = React.useMemo(() => orientationConfig[orientation], [orientation]);

    const getItemValue = React.useCallback(
        (item: T): UniqueIdentifier => {
            if (typeof item === "object" && !getItemValueProp) {
                throw new Error("getItemValue is required when using array of objects");
            }

            return getItemValueProp ? getItemValueProp(item) : (item as UniqueIdentifier);
        },
        [getItemValueProp],
    );

    const items = React.useMemo(() => value.map((item) => getItemValue(item)), [value, getItemValue]);

    const onDragStart = React.useCallback(
        (event: DragStartEvent) => {
            onDragStartProp?.(event);

            if (event.activatorEvent.defaultPrevented) {
                return;
            }

            setActiveId(event.active.id);
        },
        [onDragStartProp],
    );

    const onDragEnd = React.useCallback(
        (event: DragEndEvent) => {
            onDragEndProp?.(event);

            if (event.activatorEvent.defaultPrevented) {
                return;
            }

            const { active, over } = event;

            if (over && active.id !== over?.id) {
                const activeIndex = value.findIndex((item) => getItemValue(item) === active.id);
                const overIndex = value.findIndex((item) => getItemValue(item) === over.id);

                if (onMove) {
                    onMove({ ...event, activeIndex, overIndex });
                } else {
                    onValueChange?.(arrayMove(value, activeIndex, overIndex));
                }
            }

            setActiveId(null);
        },
        [value, onValueChange, onMove, getItemValue, onDragEndProp],
    );

    const onDragCancel = React.useCallback(
        (event: DragEndEvent) => {
            onDragCancelProp?.(event);

            if (event.activatorEvent.defaultPrevented) {
                return;
            }

            setActiveId(null);
        },
        [onDragCancelProp],
    );

    const announcements: Announcements = React.useMemo(() => {
        return {
            onDragCancel({ active }) {
                const activeIndex = active.data.current?.sortable.index ?? 0;
                const activeValue = active.id.toString();

                return `Sorting cancelled. Sortable item "${activeValue}" returned to position ${activeIndex + 1} of ${value.length}.`;
            },
            onDragEnd({ active, over }) {
                const activeValue = active.id.toString();

                if (over) {
                    const overIndex = over.data.current?.sortable.index ?? 0;

                    return `Sortable item "${activeValue}" dropped at position ${overIndex + 1} of ${value.length}.`;
                }

                return `Sortable item "${activeValue}" dropped. No changes were made.`;
            },
            onDragMove({ active, over }) {
                if (over) {
                    const overIndex = over.data.current?.sortable.index ?? 0;
                    const activeIndex = active.data.current?.sortable.index ?? 0;
                    const moveDirection = overIndex > activeIndex ? "down" : "up";
                    const activeValue = active.id.toString();

                    return `Sortable item "${activeValue}" is moving ${moveDirection} to position ${overIndex + 1} of ${value.length}.`;
                }

                return "Sortable item is no longer over a droppable area. Press escape to cancel.";
            },
            onDragOver({ active, over }) {
                if (over) {
                    const overIndex = over.data.current?.sortable.index ?? 0;
                    const activeIndex = active.data.current?.sortable.index ?? 0;
                    const moveDirection = overIndex > activeIndex ? "down" : "up";
                    const activeValue = active.id.toString();

                    return `Sortable item "${activeValue}" moved ${moveDirection} to position ${overIndex + 1} of ${value.length}.`;
                }

                return "Sortable item is no longer over a droppable area. Press escape to cancel.";
            },
            onDragStart({ active }) {
                const activeValue = active.id.toString();

                return `Grabbed sortable item "${activeValue}". Current position is ${(active.data.current?.sortable.index ?? 0) + 1} of ${value.length}. Use arrow keys to move, space to drop.`;
            },
        };
    }, [value]);

    const screenReaderInstructions: ScreenReaderInstructions = React.useMemo(() => {
        return {
            draggable: `
        To pick up a sortable item, press space or enter.
        While dragging, use the ${getMoveKeysLabel(orientation)} keys to move the item.
        Press space or enter again to drop the item in its new position, or press escape to cancel.
      `,
        };
    }, [orientation]);

    const contextValue = React.useMemo(() => {
        return {
            activeId,
            flatCursor,
            getItemValue,
            id,
            items,
            modifiers: modifiers ?? config.modifiers,
            setActiveId,
            strategy: strategy ?? config.strategy,
        };
    }, [id, items, modifiers, strategy, config.modifiers, config.strategy, activeId, getItemValue, flatCursor]);

    return (
        <SortableRootContext value={contextValue as SortableRootContextValue<unknown>}>
            <DndContext
                collisionDetection={collisionDetection ?? config.collisionDetection}
                modifiers={modifiers ?? config.modifiers}
                sensors={sensors}
                {...sortableProps}
                accessibility={{
                    announcements,
                    screenReaderInstructions,
                    ...accessibility,
                }}
                id={id}
                onDragCancel={onDragCancel}
                onDragEnd={onDragEnd}
                onDragStart={onDragStart}
            />
        </SortableRootContext>
    );
};

const SortableContentContext = React.createContext<boolean>(false);

interface SortableContentProps extends React.ComponentProps<"div"> {
    children: React.ReactNode;
    render?: React.ReactElement;
    strategy?: SortableContextProps["strategy"];
    withoutSlot?: boolean;
}

const SortableContent = (props: SortableContentProps) => {
    const { children, ref, render, strategy: strategyProp, withoutSlot, ...contentProps } = props;

    const context = useSortableContext(CONTENT_NAME);

    if (withoutSlot) {
        return (
            <SortableContentContext value>
                <SortableContext items={context.items} strategy={strategyProp ?? context.strategy}>
                    {children}
                </SortableContext>
            </SortableContentContext>
        );
    }

    if (render) {
        return (
            <SortableContentContext value>
                <SortableContext items={context.items} strategy={strategyProp ?? context.strategy}>
                    <Slot data-slot="sortable-content" render={render} {...contentProps} ref={ref}>
                        {children}
                    </Slot>
                </SortableContext>
            </SortableContentContext>
        );
    }

    return (
        <SortableContentContext value>
            <SortableContext items={context.items} strategy={strategyProp ?? context.strategy}>
                <div data-slot="sortable-content" {...contentProps} ref={ref}>
                    {children}
                </div>
            </SortableContext>
        </SortableContentContext>
    );
};

interface SortableItemContextValue {
    attributes: DraggableAttributes;
    disabled?: boolean;
    id: string;
    isDragging?: boolean;
    listeners: DraggableSyntheticListeners | undefined;
    setActivatorNodeRef: (node: HTMLElement | null) => void;
}

const SortableItemContext = React.createContext<SortableItemContextValue | null>(null);

const useSortableItemContext = (consumerName: string) => {
    const context = React.use(SortableItemContext);

    if (!context) {
        throw new Error(`\`${consumerName}\` must be used within \`${ITEM_NAME}\``);
    }

    return context;
};

interface SortableItemProps extends React.ComponentProps<"div"> {
    asHandle?: boolean;
    disabled?: boolean;
    render?: React.ReactElement;
    value: UniqueIdentifier;
}

const SortableItem = (props: SortableItemProps) => {
    const { asHandle, className, disabled, ref, render, style, value, ...itemProps } = props;

    const inSortableContent = React.use(SortableContentContext);
    const inSortableOverlay = React.use(SortableOverlayContext);

    if (!inSortableContent && !inSortableOverlay) {
        throw new Error(`\`${ITEM_NAME}\` must be used within \`${CONTENT_NAME}\` or \`${OVERLAY_NAME}\``);
    }

    if (value === "") {
        throw new Error(`\`${ITEM_NAME}\` value cannot be an empty string`);
    }

    const context = useSortableContext(ITEM_NAME);
    const id = React.useId();
    const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({ disabled, id: value });

    const composedRef = useComposedRefs(ref, (node) => {
        if (disabled) {
            return;
        }

        setNodeRef(node);

        if (asHandle) {
            setActivatorNodeRef(node);
        }
    });

    const composedStyle = React.useMemo<React.CSSProperties>(() => {
        return {
            transform: CSS.Translate.toString(transform),
            transition,
            ...style,
        };
    }, [transform, transition, style]);

    const itemContext = React.useMemo<SortableItemContextValue>(() => {
        return {
            attributes,
            disabled,
            id,
            isDragging,
            listeners,
            setActivatorNodeRef,
        };
    }, [id, attributes, listeners, setActivatorNodeRef, isDragging, disabled]);

    const commonProps = {
        "data-disabled": disabled,
        "data-dragging": isDragging ? "" : undefined,
        "data-slot": "sortable-item",
        id,
        ...itemProps,
        ...(asHandle && !disabled && attributes),
        ...(asHandle && !disabled && listeners),
        className: cn(
            "focus-visible:ring-ring focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden",
            {
                "cursor-default": context.flatCursor,
                "cursor-grab": !isDragging && asHandle && !context.flatCursor,
                "data-dragging:cursor-grabbing": !context.flatCursor,
                "opacity-50": isDragging,
                "pointer-events-none opacity-50": disabled,
                "touch-none select-none": asHandle,
            },
            className,
        ),
        ref: composedRef,
        style: composedStyle,
    };

    if (render) {
        return (
            <SortableItemContext value={itemContext}>
                <Slot {...commonProps} render={render} />
            </SortableItemContext>
        );
    }

    return (
        <SortableItemContext value={itemContext}>
            <div {...commonProps} />
        </SortableItemContext>
    );
};

interface SortableItemHandleProps extends React.ComponentProps<"button"> {
    render?: React.ReactElement;
}

const SortableItemHandle = (props: SortableItemHandleProps) => {
    const { className, disabled, ref, render, ...itemHandleProps } = props;

    const context = useSortableContext(ITEM_HANDLE_NAME);
    const itemContext = useSortableItemContext(ITEM_HANDLE_NAME);

    const isDisabled = disabled ?? itemContext.disabled;

    const composedRef = useComposedRefs(ref, (node) => {
        if (!isDisabled) {
            return;
        }

        itemContext.setActivatorNodeRef(node);
    });

    const commonProps = {
        "aria-controls": itemContext.id,
        "data-disabled": isDisabled,
        "data-dragging": itemContext.isDragging ? "" : undefined,
        "data-slot": "sortable-item-handle",
        type: "button" as const,
        ...itemHandleProps,
        ...(!isDisabled && itemContext.attributes),
        ...(!isDisabled && itemContext.listeners),
        className: cn(
            "select-none disabled:pointer-events-none disabled:opacity-50",
            context.flatCursor ? "cursor-default" : "cursor-grab data-dragging:cursor-grabbing",
            className,
        ),
        disabled: isDisabled,
        ref: composedRef,
    };

    if (render) {
        return <Slot {...commonProps} render={render} />;
    }

    // Restated after the spread: `react/button-has-type` needs a literal it can
    // see, and a drag handle is never a submit or reset control.
    return <button {...commonProps} type="button" />;
};

const SortableOverlayContext = React.createContext(false);

const dropAnimation: DropAnimation = {
    sideEffects: defaultDropAnimationSideEffects({
        styles: {
            active: {
                opacity: "0.4",
            },
        },
    }),
};

interface SortableOverlayProps extends Omit<React.ComponentProps<typeof DragOverlay>, "children"> {
    children?: ((params: { value: UniqueIdentifier }) => React.ReactNode) | React.ReactNode;
    container?: Element | DocumentFragment | null;
}

/**
 * Reports whether rendering is happening on the client, without a state update in
 * an effect: the store never changes, so the snapshot alone decides — `false`
 * while server-rendering and during hydration, `true` afterwards.
 */
const subscribeToNothing = (): (() => void) => () => {};

const getMountedOnClient = (): boolean => true;

const getMountedOnServer = (): boolean => false;

const renderSortableOverlay = (children: SortableOverlayProps["children"], value: UniqueIdentifier): React.ReactNode =>
    typeof children === "function" ? children({ value }) : children;

const SortableOverlay = (props: SortableOverlayProps) => {
    const { children, container: containerProp, ...overlayProps } = props;

    const context = useSortableContext(OVERLAY_NAME);

    const mounted = React.useSyncExternalStore(subscribeToNothing, getMountedOnClient, getMountedOnServer);

    const container = containerProp ?? (mounted ? globalThis.document?.body : null);

    if (!container) {
        return null;
    }

    return ReactDOM.createPortal(
        <DragOverlay className={cn(!context.flatCursor && "cursor-grabbing")} dropAnimation={dropAnimation} modifiers={context.modifiers} {...overlayProps}>
            <SortableOverlayContext value>{context.activeId ? renderSortableOverlay(children, context.activeId) : null}</SortableOverlayContext>
        </DragOverlay>,
        container,
    );
};

export {
    SortableContent as Content,
    SortableItem as Item,
    SortableItemHandle as ItemHandle,
    SortableOverlay as Overlay,
    //
    SortableRoot as Root,
    SortableRoot as Sortable,
    SortableContent,
    SortableItem,
    SortableItemHandle,
    SortableOverlay,
};
