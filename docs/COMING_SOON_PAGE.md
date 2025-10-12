# Coming Soon Page - gRPC & GraphQL Services

## Purpose

Placeholder page for gRPC and GraphQL services that are not yet ready for configuration.

**IMPORTANT:** This page is ONLY for gRPC and GraphQL. The Seal service uses the full configuration form designed in [UI_DESIGN.md](../UI_DESIGN.md).

## URL Routes

- `/services/grpc` - gRPC coming soon page
- `/services/graphql` - GraphQL coming soon page

## Design Specification

### Layout

Replace the standard service configuration form with a centered, friendly "coming soon" message.

```
┌──────────────────────────────────────────────────────┐
│                                                       │
│                    [Friendly Icon]                    │
│                                                       │
│          Stay Tuned!                                  │
│                                                       │
│    High-quality, usage-based {Service Name}          │
│    service coming soon!                               │
│                                                       │
│                    [Illustration]                     │
│                                                       │
│  In the meantime, check out our Seal service →       │
│                                                       │
└──────────────────────────────────────────────────────┘
```

### Content Details

**gRPC Service Page:**
```
Heading: Stay Tuned!
Body: High-quality, usage-based gRPC service coming soon!
```

**GraphQL Service Page:**
```
Heading: Stay Tuned!
Body: High-quality, usage-based GraphQL service coming soon!
```

### Visual Elements

**Icon (Top):**
- Use a friendly icon from your icon library (e.g., construction cone, rocket, or timer)
- Size: Large (64px or equivalent)
- Color: Suiftly primary orange (#f38020)
- Optional: Subtle animation (pulse or bounce)

**Illustration (Center):**
Suggested friendly illustrations (pick one):
1. **Rocket preparing to launch** (conveys "coming soon")
2. **Construction/building blocks** (conveys "in progress")
3. **Calendar with checkmark** (conveys "scheduled")
4. **Abstract geometric pattern** (simple and professional)

**Free illustration sources:**
- [unDraw](https://undraw.co/) - Customizable illustrations (can set to Suiftly orange)
- [Humaaans](https://www.humaaans.com/) - Mix-and-match illustrations
- [Lukasz Adam free illustrations](https://lukaszadam.com/illustrations)
- [Streamline free illustrations](https://www.streamlinehq.com/illustrations/free)

**Recommended illustrations:**
- unDraw: "Launch day" or "In progress" or "To-do list"
- Size: Medium (300-400px width)
- Color scheme: Match Suiftly branding (orange #f38020)

### Typography (Cloudflare cf-ui)

```css
.heading {
  font-size: 2rem; /* Cloudflare 2xl (32px) */
  font-weight: 600;
  color: #333333; /* Cloudflare Charcoal */
  margin-bottom: 16px;
}

.body-text {
  font-size: 1.13333rem; /* Cloudflare lg (~17px) */
  color: #808285; /* Cloudflare Storm (muted) */
  line-height: 1.6;
  margin-bottom: 32px;
}

.cta-link {
  font-size: 1rem; /* Cloudflare base */
  color: #2F7BBF; /* Cloudflare Marine (link color) */
  text-decoration: underline;
}
```

### Layout Styles

```css
.coming-soon-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px; /* Cloudflare spacing-6 + spacing-3 */
  text-align: center;
  min-height: 500px;
}

.icon-wrapper {
  margin-bottom: 24px;
  color: #f38020; /* Suiftly primary */
}

.illustration-wrapper {
  max-width: 400px;
  margin: 32px 0;
}

.illustration {
  width: 100%;
  height: auto;
}

.cta-wrapper {
  margin-top: 32px;
}
```

### Component Structure (React/JSX)

```tsx
// components/services/ComingSoonPage.tsx

interface ComingSoonPageProps {
  serviceName: 'gRPC' | 'GraphQL'
}

export function ComingSoonPage({ serviceName }: ComingSoonPageProps) {
  return (
    <div className="coming-soon-container">
      {/* Icon */}
      <div className="icon-wrapper">
        <RocketIcon size={64} /> {/* Or your preferred icon */}
      </div>

      {/* Heading */}
      <h1 className="heading">Stay Tuned!</h1>

      {/* Body Text */}
      <p className="body-text">
        High-quality, usage-based {serviceName} service coming soon!
      </p>

      {/* Illustration */}
      <div className="illustration-wrapper">
        <img
          src="/images/coming-soon-illustration.svg"
          alt="Coming soon illustration"
          className="illustration"
        />
      </div>

      {/* CTA Link */}
      <div className="cta-wrapper">
        <a href="/services/seal" className="cta-link">
          In the meantime, check out our Seal service →
        </a>
      </div>
    </div>
  )
}
```

### Routing Implementation (TanStack Router)

```tsx
// routes/services/grpc.tsx
import { ComingSoonPage } from '@/components/services/ComingSoonPage'

export const Route = createFileRoute('/services/grpc')({
  component: () => <ComingSoonPage serviceName="gRPC" />
})

// routes/services/graphql.tsx
import { ComingSoonPage } from '@/components/services/ComingSoonPage'

export const Route = createFileRoute('/services/graphql')({
  component: () => <ComingSoonPage serviceName="GraphQL" />
})
```

### Sidebar Navigation Behavior

When user clicks gRPC or GraphQL in sidebar:
- Navigate to coming soon page
- Service shows gray dot (not configured) in sidebar
- No tabs appear (no Config/Keys/Stats/Logs tabs)
- Clean, simple placeholder

### Accessibility

```tsx
<div
  className="coming-soon-container"
  role="main"
  aria-label={`${serviceName} service coming soon`}
>
  {/* ... */}
  <img
    src="/images/coming-soon-illustration.svg"
    alt="Illustration of work in progress"
    role="img"
  />
</div>
```

### Responsive Design

**Desktop:**
- Max width: 600px
- Centered in page
- Generous padding

**Mobile:**
- Smaller illustration (250px width)
- Reduced padding (24px sides, 32px top/bottom)
- Font sizes scale down slightly

### Optional Enhancements

1. **Email Signup (Future):**
   ```tsx
   <div className="notify-form">
     <p>Get notified when we launch:</p>
     <input type="email" placeholder="your@email.com" />
     <button>Notify Me</button>
   </div>
   ```

2. **Expected Launch Date:**
   ```tsx
   <p className="launch-date">Expected launch: Q2 2025</p>
   ```

3. **Feature Highlights:**
   ```tsx
   <div className="feature-list">
     <h3>What to expect:</h3>
     <ul>
       <li>✓ Same great pricing model</li>
       <li>✓ High-performance infrastructure</li>
       <li>✓ Global geo-steering</li>
     </ul>
   </div>
   ```

## Implementation Notes

**When scaffolding the webapp:**

1. Create `components/services/ComingSoonPage.tsx` component
2. Add routes for `/services/grpc` and `/services/graphql`
3. Download and add illustration to `public/images/`
4. Update sidebar navigation to link to these pages
5. Style with Cloudflare cf-ui design tokens (see [UI_DESIGN.md](../UI_DESIGN.md))

**Recommended illustration:**
- **unDraw "Launch day"** illustration
- Customize color to Suiftly orange (#f38020)
- Download SVG from: https://undraw.co/illustrations
- Save as: `public/images/coming-soon-illustration.svg`

## Design Consistency

Follows Cloudflare cf-ui design system: Open Sans typography, Suiftly orange primary, 0.5rem base spacing.

---

## Summary

✅ Placeholder for gRPC & GraphQL only (Seal service uses full config form from [UI_DESIGN.md](../UI_DESIGN.md))
✅ Friendly illustration with CTA to Seal service
✅ One reusable `ComingSoonPage` component

**Ready to scaffold!** 🚀
