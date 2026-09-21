/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/dashboard/**/*.{js,ts,jsx,tsx,html}",
    "./web/src/**/*.{js,ts,jsx,tsx,html,astro,md,mdx}", "./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"DM Mono"', '"Geist Mono"', 'monospace'],
      },
      colors: {
        brand: {
          DEFAULT: '#0B9F95',
          light: '#2dd4bf',
          dark: '#097d75',
        }
      }
    },
  },
  plugins: [],
}
