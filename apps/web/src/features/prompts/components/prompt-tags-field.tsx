import { useLingui } from "@lingui/react/macro";
import { Combobox, ComboboxChip, ComboboxChips, ComboboxInput, ComboboxItem, ComboboxList, ComboboxPopup, ComboboxValue } from "@neore/ui/components/combobox";
import { FormControl } from "@neore/ui/components/form";
import { useRef, useState } from "react";

export interface PromptTag {
    id: string;
    text: string;
}

interface PromptTagsFieldProps {
    onChange: (tags: PromptTag[]) => void;
    /** Tags the user already uses on other prompts, offered as suggestions. */
    options: string[];
    value: PromptTag[];
}

const toTag = (text: string): PromptTag => {
    return { id: text, text };
};

/**
 * Free-form tag input: Enter or a comma adds the typed text, pasting "a, b" adds both, and the suggestions list offers
 * the tags other prompts already carry. The input sits inside the field's `FormControl`, so the label names it.
 */
const PromptTagsField = ({ onChange, options, value }: PromptTagsFieldProps) => {
    const { t } = useLingui();
    const [inputValue, setInputValue] = useState("");
    // Whether the arrow keys have put a suggestion under the cursor: Enter then picks it instead of adding the typed text.
    const highlighted = useRef(false);

    const addTags = (texts: string[]) => {
        const next = [...value];

        for (const text of texts) {
            const trimmed = text.trim();

            if (trimmed && next.every((tag) => tag.text !== trimmed)) {
                next.push(toTag(trimmed));
            }
        }

        if (next.length > value.length) {
            onChange(next);
        }
    };

    return (
        <Combobox
            inputValue={inputValue}
            items={options}
            multiple
            onInputValueChange={(next: string) => {
                if (next.includes(",")) {
                    addTags(next.split(","));
                    setInputValue("");

                    return;
                }

                setInputValue(next);
            }}
            onItemHighlighted={(item: string | undefined) => {
                highlighted.current = item !== undefined;
            }}
            onValueChange={(texts: string[]) => onChange(texts.map((text) => value.find((tag) => tag.text === text) ?? toTag(text)))}
            value={value.map((tag) => tag.text)}
        >
            <ComboboxChips>
                <ComboboxValue>
                    {(texts: string[]) => (
                        <>
                            {texts.map((text) => (
                                <ComboboxChip aria-label={text} key={text}>
                                    {text}
                                </ComboboxChip>
                            ))}
                            <FormControl>
                                <ComboboxInput
                                    onKeyDown={(event) => {
                                        if (event.key !== "Enter" || highlighted.current) {
                                            return;
                                        }

                                        // An Enter in the field must not submit the prompt form.
                                        event.preventDefault();
                                        addTags([inputValue]);
                                        setInputValue("");
                                    }}
                                    placeholder={texts.length > 0 ? undefined : t`Add a tag`}
                                />
                            </FormControl>
                        </>
                    )}
                </ComboboxValue>
            </ComboboxChips>
            {options.length > 0 && (
                // Typed text that matches no suggestion is a new tag, not an empty list: hide the box Base UI marks `data-empty`.
                <ComboboxPopup className="has-data-empty:hidden">
                    <ComboboxList>
                        {(item: string) => (
                            <ComboboxItem key={item} value={item}>
                                {item}
                            </ComboboxItem>
                        )}
                    </ComboboxList>
                </ComboboxPopup>
            )}
        </Combobox>
    );
};

export default PromptTagsField;
