import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { applyTheme, getInitialTheme } from './theme'
import './styles.css'

// Set the theme before first paint so light-mode users don't flash dark. Done
// here (a module script) rather than an inline <script>, which the strict CSP
// (script-src 'self') would block.
applyTheme(getInitialTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
