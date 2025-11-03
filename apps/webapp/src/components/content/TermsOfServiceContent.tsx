/**
 * Terms of Service Content Component
 * Renders markdown from single source of truth
 */

import ReactMarkdown from 'react-markdown';
import tosMarkdown from '@/content/terms-of-service.md?raw';

interface TOSMetadata {
  title: string;
  version: string;
  effectiveDate: string;
  lastUpdated: string;
}

// Simple browser-compatible frontmatter parser
function parseFrontmatter(markdown: string): { data: Partial<TOSMetadata>; content: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = markdown.match(frontmatterRegex);

  if (!match) {
    return { data: {}, content: markdown };
  }

  const [, frontmatter, content] = match;
  const data: Partial<TOSMetadata> = {};

  frontmatter.split('\n').forEach(line => {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      data[key as keyof TOSMetadata] = value;
    }
  });

  return { data, content };
}

export function TermsOfServiceContent() {
  // Parse frontmatter and content
  const { data, content } = parseFrontmatter(tosMarkdown);
  const metadata = data as TOSMetadata;

  return (
    <div className="space-y-4 text-sm text-gray-600 dark:text-gray-400">
      {/* Render markdown content */}
      <ReactMarkdown
        components={{
          h1: ({ children }) => (
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-4">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-6 mb-3">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mt-4 mb-2">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="mb-3 leading-relaxed">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-5 mb-3 space-y-1">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 mb-3 space-y-1">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed">
              {children}
            </li>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-gray-900 dark:text-gray-100">
              {children}
            </strong>
          ),
          em: ({ children }) => (
            <em className="italic">
              {children}
            </em>
          ),
          hr: () => (
            <hr className="border-t border-gray-200 dark:border-gray-700 my-6" />
          ),
          code: ({ children }) => (
            <code className="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-xs font-mono">
              {children}
            </code>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// Export metadata for use elsewhere
export function getTOSMetadata(): TOSMetadata {
  const { data } = parseFrontmatter(tosMarkdown);
  return data as TOSMetadata;
}
