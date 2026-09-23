import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    resolve(root, "src/**/*.{js,ts,jsx,tsx,html}"),
    resolve(root, "app/**/*.{js,ts,jsx,tsx,html}"),
    resolve(root, "../web/src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"),
  ],
  theme: {
    extend: {
      fontFamily: {
        serif: ['"Instrument Serif"', 'Georgia', 'serif'],
        display: ['"Instrument Serif"', 'Georgia', 'serif'],
        heading: ['"Instrument Serif"', 'Georgia', 'serif'],
        tech: ['"Geist Mono"', '"JetBrains Mono"', 'monospace'],
        mono: ['"Geist Mono"', '"JetBrains Mono"', 'monospace'],
        sans: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        none: '0px',
        sm: '2px',
        md: '4px',
        lg: '6px',
      },
      boxShadow: {
        'paper-2': '2px 2px 0 var(--paper-shadow)',
        'paper-3': '3px 3px 0 var(--paper-shadow)',
        'paper-5': '5px 5px 0 var(--paper-shadow)',
        'paper-6': '6px 6px 0 var(--paper-shadow)',
        '2xs': 'var(--shadow-2xs)',
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)',
        '2xl': 'var(--shadow-2xl)',
      },
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        'paper-title': 'var(--paper-title)',
        'paper-title-foreground': 'var(--paper-title-foreground)',
        'paper-shadow': 'var(--paper-shadow)',
        'paper-dot': 'var(--paper-dot)',
        chart: {
          1: 'var(--chart-1)',
          2: 'var(--chart-2)',
          3: 'var(--chart-3)',
          4: 'var(--chart-4)',
          5: 'var(--chart-5)',
        },
        sidebar: {
          DEFAULT: 'var(--sidebar)',
          foreground: 'var(--sidebar-foreground)',
          primary: 'var(--sidebar-primary)',
          'primary-foreground': 'var(--sidebar-primary-foreground)',
          accent: 'var(--sidebar-accent)',
          'accent-foreground': 'var(--sidebar-accent-foreground)',
          border: 'var(--sidebar-border)',
          ring: 'var(--sidebar-ring)',
        },
        brand: {
          DEFAULT: 'var(--brand)',
          light: 'var(--brand-light)',
          dark: '#000086',
          glow: 'rgba(0, 0, 168, 0.18)',
        }
      }
    },
  },
  plugins: [],
}

