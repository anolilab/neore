# Pro Upgrade Marketing Triggers

This document outlines strategies and triggers for encouraging free users to upgrade to Pro.

## Current Implementation

The Pro upgrade banner is shown in the composer when:
1. **User returns to browser tab** - Detected via `visibilitychange` event
2. **User has sent less than 10 messages** - Based on daily rate limit remaining

## Additional Trigger Ideas

### 1. Feature-Limited Triggers
- **When user tries to use a Pro-only feature** (e.g., advanced models, voice input, file uploads)
  - Show contextual upgrade prompt: "Upgrade to Pro to use [feature name]"
  - Example: "Upgrade to Pro to use Claude Sonnet 4.5"

### 2. Usage-Based Triggers
- **Approaching daily limit** (e.g., 15/20 messages used)
  - Show: "You've used 15/20 messages today. Upgrade to Pro for 1000 messages/day"
- **After sending 5 messages** (early engagement)
  - Show: "You're getting the hang of it! Upgrade to Pro for unlimited conversations"
- **After 3 consecutive days of usage**
  - Show: "You're a power user! Upgrade to Pro for advanced features"

### 3. Time-Based Triggers
- **After 30 minutes of active usage**
  - Show: "You've been chatting for a while! Upgrade to Pro for faster responses"
- **First visit of the day** (for returning users)
  - Show: "Welcome back! Upgrade to Pro to unlock your full potential"
- **After 7 days since signup** (trial period)
  - Show: "Your free trial is ending soon. Upgrade to Pro to continue"

### 4. Contextual Triggers
- **When user creates 5+ threads**
  - Show: "You're organized! Upgrade to Pro to manage unlimited threads"
- **When user tries to share a thread** (if sharing is Pro-only)
  - Show: "Upgrade to Pro to share your conversations"
- **When user reaches message limit mid-conversation**
  - Show: "You've hit your daily limit. Upgrade to Pro to continue this conversation"

### 5. Engagement-Based Triggers
- **After user receives a helpful response**
  - Show: "Loving the AI? Upgrade to Pro for even better responses"
- **When user uses slash commands frequently**
  - Show: "Power user detected! Upgrade to Pro for advanced features"
- **After user saves/favorites a conversation**
  - Show: "You're building something great! Upgrade to Pro for unlimited saves"

### 6. Social Proof Triggers
- **Show upgrade prompt with social proof**
  - "Join 10,000+ Pro users who get unlimited messages"
  - "Pro users send 50x more messages on average"

### 7. Value Proposition Triggers
- **Highlight specific Pro benefits based on usage**
  - If user uses many threads: "Pro: Unlimited threads"
  - If user sends long messages: "Pro: Longer context windows"
  - If user uses multiple models: "Pro: Access to all models"

### 8. Urgency Triggers
- **Limited-time offers**
  - "Upgrade this week and get 2 months free"
- **Feature announcements**
  - "New Pro feature: Voice input! Upgrade now to try it"

## Implementation Recommendations

### Priority 1 (High Impact, Easy to Implement)
1. ✅ Tab visibility change (already implemented)
2. ✅ Message count < 10 (already implemented)
3. Approaching daily limit (15/20 messages)
4. Feature-limited prompts (when trying Pro features)

### Priority 2 (Medium Impact)
1. After 5 messages sent
2. After 30 minutes of usage
3. When creating 5+ threads
4. First visit of the day

### Priority 3 (Advanced)
1. Time-based triggers (7 days, 3 consecutive days)
2. Engagement-based triggers
3. Social proof integration
4. A/B testing different messages

## Best Practices

1. **Don't be annoying** - Limit banner frequency (e.g., max once per session)
2. **Be contextual** - Show relevant benefits based on user behavior
3. **Make it dismissible** - Allow users to close the banner
4. **Track effectiveness** - Monitor conversion rates per trigger
5. **Test and iterate** - A/B test different messages and timings
6. **Respect user choice** - Don't show to users who've dismissed multiple times

## Technical Considerations

- Use localStorage to track:
  - Last shown timestamp
  - Dismiss count
  - User preferences
- Consider rate limiting banner appearances
- Track analytics events for each trigger
- Allow feature flags for easy A/B testing
