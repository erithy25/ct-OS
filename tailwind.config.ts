import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void: 'rgb(var(--bg-void-rgb) / <alpha-value>)',
        panel: 'rgb(var(--bg-panel-rgb) / <alpha-value>)',
        panel2: 'rgb(var(--bg-panel-2-rgb) / <alpha-value>)',
        line: 'rgb(var(--line-rgb) / <alpha-value>)',
        lineb: 'rgb(var(--line-bright-rgb) / <alpha-value>)',
        prim: 'rgb(var(--text-primary-rgb) / <alpha-value>)',
        dim: 'rgb(var(--text-dim-rgb) / <alpha-value>)',
        faint: 'rgb(var(--text-faint-rgb) / <alpha-value>)',
        accent: 'rgb(var(--accent-rgb) / <alpha-value>)',
        amber: 'rgb(var(--accent-amber-rgb) / <alpha-value>)',
        red: 'rgb(var(--accent-red-rgb) / <alpha-value>)',
        green: 'rgb(var(--accent-green-rgb) / <alpha-value>)',
        violet: 'rgb(var(--accent-violet-rgb) / <alpha-value>)',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        grotesk: ['"Space Grotesk"', '"Inter Tight"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: 'var(--glow-accent)',
        'glow-amber': '0 0 12px rgba(245, 166, 35, 0.30)',
        'glow-red': '0 0 12px rgba(255, 59, 71, 0.35)',
        'glow-green': '0 0 10px rgba(52, 211, 153, 0.28)',
        'glow-violet': '0 0 12px rgba(139, 92, 246, 0.35)',
      },
      borderRadius: {
        DEFAULT: '2px',
        sm: '1px',
      },
      transitionTimingFunction: {
        tac: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
      letterSpacing: {
        lbl: '0.10em',
        wide2: '0.08em',
      },
      fontSize: {
        '2xs': ['10px', '14px'],
        '3xs': ['9px', '12px'],
      },
    },
  },
  plugins: [],
} satisfies Config
