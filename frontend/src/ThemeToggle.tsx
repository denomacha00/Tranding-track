import type { Theme } from './theme'

/**
 * Light/dark switch. Shared by the login screen and the dashboard topbar so
 * both admin and client users can flip the theme from anywhere in the app.
 */
export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      className="theme-toggle"
      onClick={onToggle}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      aria-label="Toggle light/dark theme"
      type="button"
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  )
}
