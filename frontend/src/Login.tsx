import { useState } from 'react'
import { api, setToken, AuthError } from './api'
import { ThemeToggle } from './ThemeToggle'
import type { Theme } from './theme'
import type { Me } from './types'

/**
 * Auth gate: email + password sign-in / sign-up. On success it stores the JWT
 * and calls onAuthed() so the app can load the authenticated dashboard.
 */
export function Login({
  onAuthed,
  theme,
  onToggleTheme,
}: {
  onAuthed: () => void
  theme: Theme
  onToggleTheme: () => void
}) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!email.trim() || !password) {
      setError('Email and password are required.')
      return
    }
    if (mode === 'signup' && password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    setBusy(true)
    try {
      const res =
        mode === 'login'
          ? await api.login(email.trim(), password)
          : await api.signup(email.trim(), password)
      setToken(res.access_token)
      onAuthed()
    } catch (err) {
      const msg = err instanceof AuthError || err instanceof Error ? err.message : 'Failed'
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-top">
          <div className="brand" style={{ fontSize: 20 }}>
            <span className="dot" />
            Tranding-track
          </div>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
        <p className="auth-tagline">Real-time crypto trading terminal</p>
        <p className="hint">
          {mode === 'login'
            ? 'Sign in to your trading account.'
            : 'Create an account. An administrator must grant you a licence before you can trade.'}
        </p>
        <div className="field">
          <label>Email</label>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            placeholder="you@example.com"
          />
        </div>
        <div className="field">
          <label>Password</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            placeholder="at least 8 characters"
          />
        </div>
        {error && <p className="hint" style={{ color: 'var(--red)' }}>{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Sign up'}
        </button>
        <p className="hint" style={{ marginTop: 4 }}>
          {mode === 'login' ? (
            <>
              No account?{' '}
              <a onClick={() => { setMode('signup'); setError('') }} style={{ cursor: 'pointer' }}>
                Sign up
              </a>
            </>
          ) : (
            <>
              Already registered?{' '}
              <a onClick={() => { setMode('login'); setError('') }} style={{ cursor: 'pointer' }}>
                Sign in
              </a>
            </>
          )}
        </p>
      </form>
    </div>
  )
}

/** Shown to a logged-in user whose licence is pending or revoked. */
export function LicenseGate({
  status,
  email,
  onLogout,
  onRedeemed,
  theme,
  onToggleTheme,
}: {
  status: 'pending' | 'revoked'
  email: string
  onLogout: () => void
  onRedeemed: (me: Me) => void
  theme: Theme
  onToggleTheme: () => void
}) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const redeem = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!key.trim()) {
      setError('Paste the licence key your administrator gave you.')
      return
    }
    setBusy(true)
    try {
      const me = await api.redeemLicenseKey(key.trim())
      onRedeemed(me) // flips license_status → active; app shows the dashboard
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not redeem that key.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-top">
          <div className="brand" style={{ fontSize: 20 }}>
            <span className="dot" />
            Tranding-track
          </div>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
        <p className="auth-tagline">Real-time crypto trading terminal</p>
        <h3 style={{ margin: '8px 0' }}>
          {status === 'pending' ? 'Activate your account' : 'Licence revoked'}
        </h3>
        <p className="hint">
          {status === 'pending'
            ? `Your account (${email}) is registered but not yet licensed. Enter a licence key to activate instantly, or wait for an administrator to grant access.`
            : `Your licence has been revoked. Contact the administrator to restore access — a licence key can't reactivate a revoked account.`}
        </p>
        {status === 'pending' && (
          <form onSubmit={redeem} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="field">
              <label>Licence key</label>
              <input
                className="input mono"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="TT-…"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {error && <p className="hint" style={{ color: 'var(--red)' }}>{error}</p>}
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? 'Activating…' : 'Activate with key'}
            </button>
          </form>
        )}
        <button className="btn" onClick={onLogout} style={{ marginTop: 10 }}>
          Sign out
        </button>
      </div>
    </div>
  )
}
