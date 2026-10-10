# Performance Optimization TODO

## Deferred for Later Review

### Message List Virtualization
**Status:** Deferred for compatibility testing
**File:** `apps/web/src/features/chat/thread/message-list.tsx`
**Priority:** Medium (performance gain, but needs careful testing)

**Description:**
Add virtualization using `@tanstack/react-virtual` to prevent rendering all messages in DOM simultaneously. With 100+ messages, this could provide 60-80% rendering performance improvement.

**Considerations:**
- Messages have variable heights (short text vs long code blocks with Streamdown)
- Streaming placeholder must remain separate (not virtualized)
- Need good `estimateSize` function (suggest 200px average)
- Use `overscan: 5` to keep messages above/below viewport rendered
- Test thoroughly with streaming content and Streamdown markdown rendering
- Potential for slight layout shifts with variable heights

**Implementation Pattern:**
Follow the pattern from `hierarchical-thread-list.tsx` lines 227-384:
```typescript
const virtualizer = useVirtualizer({
  count: messages.length,
  estimateSize: () => 200, // Average message height
  getScrollElement: () => parentRef.current,
  overscan: 5,
});
```

**Testing Required:**
- [ ] Verify streaming placeholder still works
- [ ] Test with long messages (code blocks, math, mermaid diagrams)
- [ ] Verify scroll position maintained during navigation
- [ ] Test edit mode with virtualized messages
- [ ] Performance profiling with 100+ messages

**Expected Impact:**
- 60-80% faster rendering with large message histories
- Lower memory usage
- Smooth scrolling with many messages

---

## In Progress
(Tasks currently being implemented will be listed here)
