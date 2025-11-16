# CopyableValue Security Pattern

## Overview

The `CopyableValue` component provides a secure way to display and copy sensitive values (API keys, addresses, etc.) with appropriate security considerations.

## Security Model

### The Approach: Keep Full Values Out of the DOM

**Key Principle:** Sensitive values (like full API keys) are kept in JavaScript memory but **never rendered to the DOM**.

### Why This Is Secure Enough

1. **DOM is the main attack surface**
   - Screen readers can't read it
   - Browser extensions can't scrape it (they parse DOM, not JS memory)
   - Screenshot/print won't capture it
   - Inspecting elements won't show it

2. **If an attacker has JS access, you're already compromised**
   - XSS attackers can steal session cookies
   - They can intercept API calls
   - They can hook into event handlers
   - Having the key in memory doesn't materially increase risk

3. **Physical access = game over anyway**
   - React DevTools can see it
   - But physical access means they can already:
     - Steal session cookies from DevTools
     - Use the authenticated session directly
     - Install keyloggers
   - Users can only inspect their own data

### What We Do

```typescript
// Backend sends both preview and full key
return {
  keyPreview: `${plainKey.slice(0, 8)}...${plainKey.slice(-4)}`,  // Rendered to DOM
  fullKey: plainKey,  // Kept in memory, never rendered
};

// Frontend keeps it in memory
<CopyableValue
  value={apiKey.keyPreview}      // Displayed (truncated)
  copyValue={apiKey.fullKey}      // Copied (full) - NOT in DOM
/>
```

### What We Avoid

❌ **Don't do this:**
```tsx
// BAD: Full key in DOM
<div data-full-key={fullKey}>{preview}</div>

// BAD: Full key as value attribute
<input type="hidden" value={fullKey} />

// BAD: Full key in title/alt/aria attributes
<span title={fullKey}>{preview}</span>
```

✅ **Do this:**
```tsx
// GOOD: Full key only in JS closure
const handleCopy = () => {
  navigator.clipboard.writeText(fullKey);  // fullKey from props/state
};
```

## Implementation

### Component Usage

```tsx
import { CopyableValue } from "@/components/ui/copyable-value";

// Simple value (no truncation)
<CopyableValue value="some-value" />

// Truncated display, full copy
<CopyableValue
  value="sk_abc123...xyz789"
  copyValue="sk_abc123def456ghi789xyz789"
/>

// With blockchain explorer link
<CopyableValue
  value="0x1234...5678"
  copyValue="0x123456789abcdef..."
  type="sui_address_mainnet"
/>
```

### Backend Pattern

```typescript
// Decrypt and return both preview and full value
const plainKey = decryptSecret(key.apiKeyId);
return {
  keyPreview: `${plainKey.slice(0, 8)}...${plainKey.slice(-4)}`,
  fullKey: plainKey,  // Sent to frontend but not rendered
};
```

## Alternative Approaches Considered

### ❌ Fetch-on-Copy (Rejected - Overkill)

```typescript
// Fetch full key only when user clicks copy
const handleCopy = async () => {
  const { fullKey } = await api.getFullKey(keyId);
  await clipboard.writeText(fullKey);
};
```

**Why rejected:**
- More complex (extra API endpoint)
- Minimal security benefit (if attacker has JS, they can hook this anyway)
- Worse UX (network delay on copy)
- Still vulnerable to same XSS threats

### ✅ Current Approach (Accepted - Simple & Secure)

```typescript
// Full key loaded with data, kept in memory
const handleCopy = () => {
  clipboard.writeText(fullKey);  // Instant, no network call
};
```

**Why accepted:**
- Simple implementation
- Instant copy (better UX)
- Same security properties as fetch-on-copy
- Easier to maintain

## Threat Model

### Protected Against

✅ **DOM scraping** - Extensions/scripts that parse DOM
✅ **Passive observation** - Screenshots, screen readers
✅ **Accidental logging** - Console logs, error reporting

### NOT Protected Against (But Already Compromised)

⚠️ **XSS attacks** - If attacker has JS execution:
- Can hook clipboard API
- Can steal session tokens
- Can intercept network calls
- Having key in memory is least of your problems

⚠️ **Physical access with DevTools** - But they can:
- Steal session cookies
- Use authenticated session
- Install persistent malware

## Best Practices

1. **Always use HTTPS** (prevents MITM)
2. **Proper authentication** (prevents unauthorized access)
3. **Never log sensitive values** (use `[REDACTED]` in logs)
4. **Never render to DOM** (keep in JS memory only)
5. **Show only once on creation** (modal with "save now" warning)

## References

- Component: `apps/webapp/src/components/ui/copyable-value.tsx`
- Backend endpoint: `apps/api/src/routes/seal.ts` (`listApiKeys`)
- Usage example: `apps/webapp/src/components/services/ApiKeysSection.tsx`
