# Terms of Service - Single Source of Truth

This directory contains the Terms of Service content in markdown format, which serves as the **single source of truth** for both the web UI and PDF generation.

## Files

- **`terms-of-service.md`** - The authoritative ToS content with YAML frontmatter metadata
- **`TermsOfServiceContent.tsx`** - React component that renders the markdown in the web UI

## Workflow

### 1. Edit the Terms of Service

Edit the content in `terms-of-service.md`. The file uses:
- **YAML frontmatter** for metadata (title, version, effective date)
- **Markdown** for the content (headings, lists, paragraphs)

Example:
```markdown
---
title: Suiftly Seal Service Agreement
version: 1.0
effectiveDate: 2025-01-15
lastUpdated: 2025-01-15
---

# Suiftly Seal Service Agreement

Content goes here...
```

### 2. Generate the PDF

After editing the markdown, run the PDF generation script:

```bash
# From repository root
python3 scripts/rare/update-tos.py
```

This will:
1. Read `apps/webapp/src/content/terms-of-service.md`
2. Convert markdown to HTML
3. Apply professional styling (Cloudflare colors, proper typography)
4. Generate PDF at `apps/webapp/public/terms-of-service.pdf`

**First time setup:**
```bash
sudo apt install python3-markdown2 weasyprint
```

### 3. The Web UI Automatically Updates

The React component automatically reads from `terms-of-service.md`, so changes appear immediately in the browser (with hot reload).

## Benefits of This Approach

1. **Single Source of Truth** - Edit markdown once, used everywhere
2. **Version Control** - ToS changes tracked in git with full history
3. **Legal Review** - Non-technical team members can edit markdown
4. **Consistency** - Web UI and PDF always match
5. **Static Site Compatible** - Markdown is bundled at build time via Vite's `?raw` import
6. **No Runtime Dependencies** - PDF generation is offline, web UI uses react-markdown

## Usage in Code

```typescript
import { TermsOfServiceContent } from '@/components/content/TermsOfServiceContent';

// In a React component:
<div className="overflow-y-auto">
  <TermsOfServiceContent />
</div>
```

## PDF Download

The PDF download button in `SealConfigForm.tsx` downloads from `/terms-of-service.pdf` (the public folder).

Users can:
1. View ToS in the modal dialog (rendered from markdown)
2. Download the PDF version (generated from the same markdown)

Both will always match because they come from the same source file.
