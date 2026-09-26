/** @type {import('tailwindcss').Config} */
export default {
  future: {
    // Prevent persistent :hover styles after taps on touchscreens.
    hoverOnlyWhenSupported: true,
  },
  content: [
    "./src/**/*.{js,ts,jsx,tsx,html,astro,md,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Bebas Neue"', 'Impact', 'sans-serif'],
        comic: ['Bangers', '"Comic Sans MS"', 'cursive', 'sans-serif'],
        tech: ['"DM Mono"', '"Geist Mono"', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        brand: {
          DEFAULT: '#0B9F95',
          light: '#2dd4bf',
          dark: '#097d75',
          glow: 'rgba(11, 159, 149, 0.25)',
        }
      }
    },
  },
  plugins: [],
}
