/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class', // Enable class-based dark mode (next-themes sets .dark on <html>)
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // Cloudflare cf-ui design system colors
      colors: {
        // Cloudflare primary palette
        marine: '#2F7BBF',
        grass: '#9BCA3E',
        apple: '#BD2527',
        tangerine: '#FF7900',

        // Cloudflare neutrals
        moonshine: '#F7F7F7',
        dust: '#ebebeb',
        smoke: '#e0e0e0',
        hail: '#BCBEC0',
        storm: '#808285',
        charcoal: '#333333',

        // Semantic colors
        primary: '#2F7BBF',    // Marine
        success: '#9BCA3E',    // Grass
        warning: '#FF7900',    // Tangerine
        danger: '#BD2527',     // Apple
      },
      fontFamily: {
        sans: ['"Open Sans"', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      fontSize: {
        'cf-xs': '0.73333rem',    // ~11px
        'cf-sm': '0.86667rem',    // ~13px
        'cf-base': '0.93333rem',  // ~14px
        'cf-lg': '1.46667rem',    // ~22px (headings)
        'cf-xl': '2rem',          // ~32px
      },
      borderRadius: {
        'cf': '3px',              // Cloudflare default
      },
      boxShadow: {
        'cf-sm': '0 1px 1px rgba(0, 0, 0, 0.05)',
        'cf': '0 2px 8px rgba(0, 0, 0, 0.1)',
      },
    },
  },
  plugins: [],
  // Tailwind v4: Explicitly enable default utilities
  corePlugins: {
    preflight: true,
  },
};
