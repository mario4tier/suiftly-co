#!/usr/bin/env python3
"""
Generate PDF from Terms of Service markdown file.

This script converts apps/webapp/src/content/terms-of-service.md to PDF
and places the output in apps/webapp/public/terms-of-service.pdf.

Requirements:
    sudo apt install python3-markdown2 weasyprint
"""

import os
import sys
from pathlib import Path

# Check dependencies
try:
    import markdown2
    import weasyprint
except ImportError as e:
    print("Error: Missing required dependencies")
    print("\nInstall with:")
    print("  sudo apt install python3-markdown2 weasyprint")
    sys.exit(1)

# Paths
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
MD_PATH = REPO_ROOT / "apps/webapp/src/content/terms-of-service.md"
OUTPUT_PATH = REPO_ROOT / "apps/webapp/public/terms-of-service.pdf"

# CSS styling for PDF
PDF_CSS = """
@page {
    size: letter;
    margin: 1in;
    @bottom-right {
        content: "Page " counter(page) " of " counter(pages);
        font-size: 9pt;
        color: #666;
    }
}

body {
    font-family: 'Helvetica', 'Arial', sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #333;
}

h1 {
    font-size: 24pt;
    font-weight: bold;
    color: #1a1a1a;
    margin-top: 0;
    margin-bottom: 24pt;
    border-bottom: 2px solid #2F7BBF;
    padding-bottom: 8pt;
}

h2 {
    font-size: 14pt;
    font-weight: bold;
    color: #2F7BBF;
    margin-top: 18pt;
    margin-bottom: 12pt;
}

h3 {
    font-size: 12pt;
    font-weight: bold;
    color: #333;
    margin-top: 12pt;
    margin-bottom: 8pt;
}

p {
    margin-bottom: 10pt;
    text-align: justify;
}

ul, ol {
    margin-bottom: 10pt;
    padding-left: 20pt;
}

li {
    margin-bottom: 6pt;
}

strong {
    font-weight: bold;
    color: #1a1a1a;
}

em {
    font-style: italic;
}

hr {
    border: none;
    border-top: 1px solid #ccc;
    margin: 20pt 0;
}

code {
    font-family: 'Courier New', monospace;
    background-color: #f5f5f5;
    padding: 2pt 4pt;
    border-radius: 3pt;
}
"""


def extract_frontmatter(content: str) -> tuple[dict, str]:
    """Extract YAML frontmatter from markdown content."""
    if not content.startswith('---'):
        return {}, content

    parts = content.split('---', 2)
    if len(parts) < 3:
        return {}, content

    frontmatter = {}
    for line in parts[1].strip().split('\n'):
        if ':' in line:
            key, value = line.split(':', 1)
            frontmatter[key.strip()] = value.strip()

    return frontmatter, parts[2].strip()


def markdown_to_pdf(md_path: Path, output_path: Path):
    """Convert markdown file to PDF."""
    print(f"Reading markdown from: {md_path}")

    if not md_path.exists():
        print(f"Error: Markdown file not found at {md_path}")
        sys.exit(1)

    # Read markdown content
    with open(md_path, 'r', encoding='utf-8') as f:
        content = f.read()

    # Extract frontmatter
    frontmatter, markdown_content = extract_frontmatter(content)

    # Convert markdown to HTML
    html_content = markdown2.markdown(
        markdown_content,
        extras=['fenced-code-blocks', 'tables', 'header-ids']
    )

    # Wrap in HTML document
    html_doc = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>{frontmatter.get('title', 'Terms of Service')}</title>
        <style>{PDF_CSS}</style>
    </head>
    <body>
        {html_content}
    </body>
    </html>
    """

    # Ensure output directory exists
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # Generate PDF
    print(f"Generating PDF at: {output_path}")
    weasyprint.HTML(string=html_doc).write_pdf(output_path)

    print(f"✓ PDF generated successfully!")
    print(f"  Title: {frontmatter.get('title', 'N/A')}")
    print(f"  Version: {frontmatter.get('version', 'N/A')}")
    print(f"  Effective Date: {frontmatter.get('effectiveDate', 'N/A')}")
    print(f"  Output: {output_path}")


def main():
    """Main entry point."""
    print("Suiftly Terms of Service PDF Generator")
    print("=" * 50)

    try:
        markdown_to_pdf(MD_PATH, OUTPUT_PATH)
    except Exception as e:
        print(f"\nError generating PDF: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()
