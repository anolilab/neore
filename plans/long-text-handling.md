# Long Text Handling

## Overview

The composer automatically manages long text input by converting it into attachments, creating a cleaner UX and better handling of large content blocks.

## Features

### 1. **Automatic Paste Conversion**

When users paste long text (>500 characters or >10 lines):
- ✅ **Instant conversion** to text file attachment
- ✅ **No user confirmation** required
- ✅ **Clean attachment preview** with document icon
- ✅ **Progress indicator** during upload

**Thresholds:**
- 500 characters OR
- 10 lines

**File naming:**
- Auto-generated: `pasted-text-YYYY-MM-DD.txt`

### 2. **Manual Conversion Prompt**

For typed (not pasted) long text:
- 💡 **Inline suggestion** appears above textarea
- 🔵 **Blue info banner** with "Convert" button
- ⛔ **Dismissible** (per session)
- 📝 **One-click conversion** to attachment

**UX Flow:**
```
Type 500+ chars → Suggestion appears → Click "Convert" → Text becomes attachment
```

### 3. **Visual Indicators**

**Character Counter:**
- Appears when text > 300 characters
- Shows: character count + line count
- Positioned: top-right of textarea
- Styled: minimal, non-intrusive pill

**Text Attachment Preview:**
- Expanded card layout (vs thumbnail for images)
- Blue-tinted design to distinguish from images
- Shows filename + "Text document" label
- Progress bar during upload
- Remove button

## Implementation

### Components

1. **ComposerLongTextPrompt** (`composer-long-text-prompt.tsx`)
   - Suggestion banner for manual conversion
   - Configurable thresholds
   - Dismissible state management

2. **ComposerTextCounter** (`composer-text-counter.tsx`)
   - Character/line counter overlay
   - Animated appearance
   - Minimal design

3. **AttachmentPreview** (enhanced in `composer-input.tsx`)
   - Special rendering for text files
   - Card layout vs thumbnail
   - Blue accent color theme

### Auto-Conversion Logic

```typescript
// In handlePaste callback
if (chars > 500 || lines > 10) {
    e.preventDefault();

    // Create text file
    const blob = new Blob([pastedText], { type: 'text/plain' });
    const file = new File([blob], `pasted-text-${date}.txt`, {
        type: 'text/plain'
    });

    // Upload as attachment
    await uploadAttachment(file);
}
```

## Benefits

### User Experience
- ✅ **Cleaner interface** - no overflowing textareas
- ✅ **Faster workflow** - paste and send immediately
- ✅ **Better organization** - long content treated as documents
- ✅ **Visual clarity** - clear separation between prompt and content

### Technical
- ✅ **Better token management** - attachments can be handled separately
- ✅ **Consistent processing** - long text processed like uploaded files
- ✅ **Better memory** - files can be cached/referenced
- ✅ **Scalability** - handles arbitrarily long content

## Configuration

### Thresholds

Adjust in `composer-input.tsx`:

```typescript
// Automatic paste conversion
if (chars > 500 || lines > 10) {
    // convert
}

// Manual conversion prompt
<ComposerLongTextPrompt
    threshold={500}    // characters
    minLines={10}      // lines
/>

// Character counter appearance
<ComposerTextCounter
    threshold={300}    // show at 300 chars
/>
```

### Styling

All components use theme-aware colors:
- Light mode: Blue 50/600
- Dark mode: Blue 950/400
- Minimal aesthetic matching Perplexity design

## Preview & Editor Mode

### Editable File Types

Text attachments can be **previewed and edited** before sending:

**Supported formats:**
- Plain text (`.txt`)
- Markdown (`.md`)
- JSON (`.json`)
- JavaScript/TypeScript (`.js`, `.ts`, `.jsx`, `.tsx`)
- Python (`.py`)
- HTML/CSS (`.html`, `.css`)
- YAML (`.yaml`, `.yml`)
- SQL (`.sql`)
- Shell scripts (`.sh`)
- And more...

### Features

**Preview Mode:**
- ✅ Read-only view with monospace font
- ✅ Syntax-preserving display
- ✅ Line and character count
- ✅ Scrollable for long content
- ✅ Clean, minimal interface

**Edit Mode:**
- ✏️ Full editing capability
- ✏️ Auto-resizing textarea
- ✏️ "Modified" badge when changed
- ✏️ Save/Cancel buttons
- ✏️ Preserves formatting

### User Flow

**Opening Editor:**
```
1. Click on text attachment card
   OR
2. Click edit icon on card
   → Editor opens with content loaded
```

**Editing:**
```
1. Click "Edit" button
2. Modify content in textarea
3. "Modified" badge appears
4. Click "Save" or "Cancel"
   → Changes applied to attachment
```

**Quick Actions:**
- **Save**: Updates attachment with new content
- **Cancel**: Discards changes, returns to preview
- **Close (X)**: Closes editor, returns to card view

### UI Components

**Text Attachment Card (Collapsed):**
- Blue-themed card
- "Click to edit" subtitle
- Edit icon button
- Hover effect indicating clickability

**Editor Modal (Expanded):**
- Full-width editor panel
- Header with filename + status
- Mode toggle (Preview ↔ Edit)
- Footer with stats (lines, chars)
- Proper close/save controls

### Implementation

**Component:**
```typescript
<TextAttachmentEditor
    file={file}
    onUpdate={(newFile) => handleUpdate(newFile)}
    onClose={() => closeEditor()}
/>
```

**File Type Detection:**
```typescript
const isEditable = (file: File): boolean => {
    // Check MIME type
    if (EDITABLE_TYPES.has(file.type)) return true;

    // Check file extension
    const ext = file.name.split('.').pop();
    return editableExts.includes(ext);
};
```

## Future Enhancements

Potential improvements:
- [ ] Syntax highlighting for code
- [ ] Markdown live preview
- [ ] Custom filename editing
- [ ] Find & replace in editor
- [ ] Line numbers
- [ ] Code formatting (prettier)
- [ ] Auto-detect language/format
- [ ] Diff view for changes
- [ ] Token count estimation
- [ ] Export edited version

## User Feedback

Consider adding:
- Toast notification on auto-conversion
- Undo option (restore to textarea)
- Settings to adjust thresholds
- Option to disable auto-conversion
