import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import type { LicenseKeyRow, UserRow } from './types'

/** Admin dashboard: list users and grant/revoke their trading licence. */
export function Admin({ onError }: { onError: (msg: string) => void }) {
  const [users, setUsers] = useState<UserRow[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      setUsers(await api.adminUsers())
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [onError])

  useEffect(() => {
    load()
  }, [load])

  const setLicense = async (id: number, status: 'active' | 'revoked' | 'pending') => {
    try {
      await api.adminSetLicense(id, status)
      await load()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const addDays = async (id: number) => {
    const v = prompt('Add how many days of access for this client?', '30')
    if (v == null) return
    const n = parseInt(v, 10)
    if (!Number.isFinite(n) || n < 1 || n > 3650) {
      onError('Enter a whole number of days between 1 and 3650.')
      return
    }
    try {
      await api.adminAddDays(id, n)
      await load()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const remove = async (id: number, who: string) => {
    if (!confirm(`Delete ${who}? This removes the account permanently.`)) return
    try {
      await api.adminDeleteUser(id)
      await load()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  // Effective-access badge: green only when truly live (active AND not expired).
  const badge = (u: UserRow) =>
    u.license_active ? 'on' : u.license_status === 'revoked' ? 'off' : ''

  // What to show in the Licence cell: an expired time-limited licence reads
  // "expired" even though its raw status is still "active".
  const licenceLabel = (u: UserRow) =>
    u.license_status === 'active' && !u.license_active ? 'expired' : u.license_status

  const accessLabel = (u: UserRow) => {
    if (!u.license_active) return '—'
    if (u.license_days_left == null) return 'lifetime'
    return `${u.license_days_left}d left`
  }

  const active = users.filter((u) => u.license_active).length
  const pending = users.filter((u) => u.license_status === 'pending').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <p className="hint">
          Grant, revoke or extend user licences. Only currently-live users can enter
          API keys and trade. {users.length} users · {active} live · {pending} pending.
        </p>
        <div className="row">
          <button className="btn" onClick={load} disabled={busy}>
            {busy ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {users.length === 0 ? (
          <div className="empty">No users yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Username</th>
                <th>Email</th>
                <th>Role</th>
                <th>Licence</th>
                <th>Access</th>
                <th>Registered</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="mono">{u.id}</td>
                  <td>{u.username || <span className="hint">—</span>}</td>
                  <td>{u.email}</td>
                  <td>{u.role}</td>
                  <td>
                    <span className={`tag ${badge(u)}`}>{licenceLabel(u)}</span>
                  </td>
                  <td className="mono">{accessLabel(u)}</td>
                  <td className="mono">{u.created_at?.slice(0, 10)}</td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {!u.license_active ? (
                        <button className="btn buy" onClick={() => setLicense(u.id, 'active')}>
                          Grant
                        </button>
                      ) : (
                        <button className="btn sell" onClick={() => setLicense(u.id, 'revoked')}>
                          Revoke
                        </button>
                      )}
                      <button className="btn" onClick={() => addDays(u.id)}>
                        + Days
                      </button>
                      {u.role !== 'admin' && (
                        <button
                          className="btn"
                          onClick={() => remove(u.id, u.username || u.email)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <LicenseKeys onError={onError} />
    </div>
  )
}

/**
 * Licence-key management: generate one-time keys a NEW user can redeem to
 * activate themselves instantly (no manual per-user approval). The full key is
 * shown ONCE at generation — only its hash is stored server-side — so it must be
 * copied immediately.
 */
function LicenseKeys({ onError }: { onError: (msg: string) => void }) {
  const [keys, setKeys] = useState<LicenseKeyRow[]>([])
  const [label, setLabel] = useState('')
  const [days, setDays] = useState('') // blank = lifetime key
  const [busy, setBusy] = useState(false)
  const [justCreated, setJustCreated] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      setKeys(await api.adminLicenseKeys())
    } catch (e) {
      onError((e as Error).message)
    }
  }, [onError])

  useEffect(() => {
    load()
  }, [load])

  const generate = async () => {
    // Empty days = a lifetime key; otherwise validate the day count up front.
    let duration: number | null = null
    if (days.trim()) {
      const n = parseInt(days, 10)
      if (!Number.isFinite(n) || n < 1 || n > 3650) {
        onError('Days must be a whole number between 1 and 3650 (or blank for lifetime).')
        return
      }
      duration = n
    }
    setBusy(true)
    setCopied(false)
    try {
      const created = await api.adminCreateLicenseKey(label.trim() || undefined, duration)
      setJustCreated(created.key) // shown once; never returned again
      setLabel('')
      setDays('')
      await load()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!justCreated) return
    try {
      await navigator.clipboard.writeText(justCreated)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const revoke = async (id: number) => {
    if (!confirm('Revoke this unused key? It can no longer be redeemed.')) return
    try {
      await api.adminRevokeLicenseKey(id)
      await load()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const keyBadge = (s: string) =>
    s === 'unused' ? 'on' : s === 'revoked' ? 'off' : ''

  const unused = keys.filter((k) => k.status === 'unused').length

  return (
    <div className="panel" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <h3 style={{ margin: '0 0 4px' }}>Licence keys</h3>
        <p className="hint" style={{ margin: 0 }}>
          Generate a key (give it a client name and how many days it lasts), then
          share it — the client pastes it when signing up to go live instantly. A
          blank day count makes a lifetime key. {keys.length} keys · {unused} unused.
        </p>
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input
          className="input"
          style={{ maxWidth: 220 }}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Client name (optional, e.g. “Alice”)"
          maxLength={120}
        />
        <input
          className="input"
          style={{ maxWidth: 150 }}
          type="number"
          min={1}
          max={3650}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          placeholder="Days (blank = lifetime)"
        />
        <button className="btn primary" onClick={generate} disabled={busy}>
          {busy ? 'Generating…' : 'Generate key'}
        </button>
      </div>

      {justCreated && (
        <div className="callout">
          <div className="hint" style={{ marginBottom: 6 }}>
            Copy this key now — it is shown <strong>once</strong> and cannot be
            retrieved again:
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <code className="mono keyval" style={{ flex: 1, wordBreak: 'break-all' }}>
              {justCreated}
            </code>
            <button className="btn" onClick={copy}>
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
            <button className="btn" onClick={() => setJustCreated(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {keys.length === 0 ? (
        <div className="empty">No keys yet.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Client</th>
              <th>Duration</th>
              <th>Status</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td className="mono">{k.key_prefix}…</td>
                <td>{k.label || <span className="hint">—</span>}</td>
                <td className="mono">
                  {k.duration_days ? `${k.duration_days}d` : 'lifetime'}
                </td>
                <td>
                  <span className={`tag ${keyBadge(k.status)}`}>{k.status}</span>
                </td>
                <td className="mono">{k.created_at?.slice(0, 10)}</td>
                <td>
                  {k.status === 'unused' && (
                    <button className="btn sell" onClick={() => revoke(k.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
