import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  future: {
    // Prevent persistent :hover styles after taps on touchscreens.
    hoverOnlyWhenSupported: true,
  },
  // Class strategy so `dark:` variants follow the in-app next-themes toggle
  // (html.dark), not the OS prefers-color-scheme — otherwise AppNavRail and
  // AuthScreen stay dark on an OS-dark machine while the rest of the app
  // (which remaps tokens under html.dark in styles.css) is light.
  darkMode: "class",
  content: [
    resolve(root, "src/**/*.{js,ts,jsx,tsx,html}"),
    resolve(root, "../web/src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"),
  ],
  theme: {
    extend: {
      // `touch:` targets coarse pointers (phones/tablets) for 44px tap targets.
      screens: {
        touch: { raw: "(pointer: coarse)" },
      },
      fontFamily: {
        display: ['"Instrument Serif"', 'Georgia', 'serif'],
        comic: ['Bangers', '"Comic Sans MS"', 'cursive', 'sans-serif'],
        tech: ['"Geist Mono"', '"DM Mono"', 'monospace'],
        sans: ['Geist', 'Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          DEFAULT: '#0000a8',
          light: '#1c1cc8',
          dark: '#000086',
          glow: 'rgba(0, 0, 168, 0.18)',
        }
      }
    },
  },
  plugins: [],
}
