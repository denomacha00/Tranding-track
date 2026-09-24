import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import type { UserRow } from './types'

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

  const remove = async (id: number, email: string) => {
    if (!confirm(`Delete ${email}? This removes the account permanently.`)) return
    try {
      await api.adminDeleteUser(id)
      await load()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const badge = (s: string) =>
    s === 'active' ? 'on' : s === 'revoked' ? 'off' : ''

  const active = users.filter((u) => u.license_status === 'active').length
  const pending = users.filter((u) => u.license_status === 'pending').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p className="hint">
        Grant or revoke user licences. Only licensed users can enter API keys and
        trade. {users.length} users · {active} active · {pending} pending.
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
              <th>Email</th>
              <th>Role</th>
              <th>Licence</th>
              <th>Registered</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td className="mono">{u.id}</td>
                <td>{u.email}</td>
                <td>{u.role}</td>
                <td>
                  <span className={`tag ${badge(u.license_status)}`}>
                    {u.license_status}
                  </span>
                </td>
                <td className="mono">{u.created_at?.slice(0, 10)}</td>
                <td>
                  <div className="row" style={{ gap: 6 }}>
                    {u.license_status !== 'active' ? (
                      <button className="btn buy" onClick={() => setLicense(u.id, 'active')}>
                        Grant
                      </button>
                    ) : (
                      <button className="btn sell" onClick={() => setLicense(u.id, 'revoked')}>
                        Revoke
                      </button>
                    )}
                    {u.role !== 'admin' && (
                      <button className="btn" onClick={() => remove(u.id, u.email)}>
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
  )
}
