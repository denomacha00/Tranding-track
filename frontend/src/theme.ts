// Light/dark theme: persisted to localStorage, defaulting to the OS preference.
// The active theme is written to <html data-theme="…"> and every colour in
// styles.css is derived from CSS variables keyed off that attribute, so the
// whole app (client + admin + login) re-themes instantly with no reload.
import { useCallback, useEffect, useState } from 'react'

export type Theme = 'dark' | 'light'

const KEY = 'tt_theme'

export function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'dark' || saved === 'light') return saved
  } catch {
    /* localStorage may be unavailable (private mode) — fall back below. */
  }
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return 'dark'
}

export function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme
  }
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* ignore persistence failures */
  }
}

/** React hook: returns the current theme and a toggle. Applies on mount/change. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  return [theme, toggle]
}
