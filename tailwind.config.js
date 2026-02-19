/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        display: ["'Inter Tight'", "Inter", "system-ui", "sans-serif"],
        body: ["Inter", "system-ui", "sans-serif"],
        mono: ["'IBM Plex Mono'", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        table: "#1f6030",
        "table-felt": "#1b4c28",
        "panel": "#0d1c2b",
        "panel-soft": "#12283a",
        accent: "#10b981",
      },
      boxShadow: {
        panel: "0 12px 45px rgba(0,0,0,0.28)",
      },
    },
  },
  plugins: [],
};
