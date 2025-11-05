# Route Security

## Overview

All routes in this application require authentication by default. This is a **fail-secure** design that prevents accidental exposure of protected content.

## How It Works

### Global Auth Guard

The root route (`apps/webapp/src/routes/__root.tsx`) implements a global `beforeLoad` guard that:

1. Checks if the requested route is in the `PUBLIC_ROUTES` allowlist
2. If public, allows access
3. If not public, checks authentication status
4. Redirects to `/login` if not authenticated

```typescript
const PUBLIC_ROUTES = new Set([
  '/',       // Index route - handles its own auth check and redirects
  '/login',  // Login page
]);
```

### Why This is Secure

**Fail-Secure by Default:**
- New routes are automatically protected
- Developers must explicitly add routes to `PUBLIC_ROUTES` to make them public
- This prevents the "forgot to add auth guard" error

**Single Source of Truth:**
- All auth logic is centralized in `__root.tsx`
- No need to remember to add `beforeLoad` to each route
- Easy to audit (just check `PUBLIC_ROUTES`)

## Adding New Routes

### Protected Routes (Default)

Simply create your route file - it's automatically protected:

```typescript
// apps/webapp/src/routes/my-new-page.tsx
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/my-new-page')({
  component: MyNewPage,
});
```

**No auth guard needed!** The global guard handles it.

### Public Routes (Rare)

If you need a route accessible without authentication:

1. **Add to PUBLIC_ROUTES** in `__root.tsx`:
   ```typescript
   const PUBLIC_ROUTES = new Set([
     '/',
     '/login',
     '/my-public-page',  // Your new public route
   ]);
   ```

2. **Document why it's public** with a comment
3. **Get security review** before merging

## Testing Route Security

### Manual Testing

1. Open browser in incognito mode
2. Clear localStorage: `localStorage.clear()`
3. Try to access protected routes - should redirect to `/login`
4. Try to access public routes - should load

### Automated Testing

We have E2E tests that verify route security. Add new routes to the test file:

```bash
npx playwright test auth.spec.ts --project=chromium
```

## Common Patterns

### Index Route (/)

The `/` route is special - it's in `PUBLIC_ROUTES` but handles its own auth logic:
- If authenticated → redirects to `/dashboard`
- If not authenticated → redirects to `/login`

This allows `/` to be the entry point while still enforcing auth.

### Lazy Routes

Lazy-loaded routes (`.lazy.tsx`) are also protected:

```typescript
// routes/my-page.tsx (route definition)
export const Route = createFileRoute('/my-page')({
  component: () => null,
});

// routes/my-page.lazy.tsx (component implementation)
export const Route = createLazyFileRoute('/my-page')({
  component: MyPageComponent,
});
```

The auth guard runs before lazy loading, so unauthorized users never download the component code.

## Security Checklist

When adding/modifying routes:

- [ ] Is this route supposed to be public? (99% should say NO)
- [ ] If public, is it in `PUBLIC_ROUTES`?
- [ ] If public, is there a security-reviewed reason?
- [ ] Does the route handle sensitive data? (Add additional checks if needed)
- [ ] Have you tested unauthorized access?

## Future Improvements

Potential enhancements to this system:

1. **Role-based access control** - Different routes for different user roles
2. **Route-level permissions** - Fine-grained access control per route
3. **Automated testing** - Script that verifies all routes are either in PUBLIC_ROUTES or properly protected
4. **Pre-commit hook** - Prevents commits that modify PUBLIC_ROUTES without security review

## Troubleshooting

### "Stuck in redirect loop"

If you see infinite redirects:
- Check if `/login` is in `PUBLIC_ROUTES`
- Check if `/` index route is in `PUBLIC_ROUTES`
- Look for routes that redirect to themselves

### "Route not protected"

If a route loads without auth:
- Check if it's accidentally in `PUBLIC_ROUTES`
- Verify `__root.tsx` global guard is active
- Check browser console for auth errors

### "401 Unauthorized" on page load

This is expected behavior - the page should redirect to `/login`. If it doesn't:
- Check that `__root.tsx` guard is properly configured
- Verify `useAuthStore` is working correctly
- Check browser console for errors

## Questions?

See also:
- [docs/AUTHENTICATION_DESIGN.md](./AUTHENTICATION_DESIGN.md) - Full auth flow documentation
- [apps/webapp/src/routes/__root.tsx](../apps/webapp/src/routes/__root.tsx) - Auth guard implementation
