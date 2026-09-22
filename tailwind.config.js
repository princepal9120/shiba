/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/dashboard/**/*.{js,ts,jsx,tsx,html}",
    "./web/src/**/*.{js,ts,jsx,tsx,html,astro,md,mdx}", "./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"
  ],
  theme: {
    extend: {
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
