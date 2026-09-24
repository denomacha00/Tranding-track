import { useEffect, useRef, useState } from 'react'
import { getToken, notifyAuthFailure } from './api'
import type { BotStatus, WsMessage } from './types'

type Handlers = {
  onStatus?: (s: BotStatus) => void
  onEvent?: (m: WsMessage) => void
}

// Close code the server uses when the token is missing/invalid/expired.
const WS_AUTH_FAILED = 4401

// Auto-reconnecting WebSocket to the backend /ws endpoint.
export function useSocket({ onStatus, onEvent }: Handlers) {
  const [connected, setConnected] = useState(false)
  const handlers = useRef<Handlers>({ onStatus, onEvent })
  handlers.current = { onStatus, onEvent }

  useEffect(() => {
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let closed = false

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const token = getToken()
      if (!token) {
        retry = setTimeout(connect, 2000)
        return
      }
      // Carry the token as a WebSocket subprotocol ("bearer", <token>) rather
      // than in the query string, so it never lands in server/proxy access
      // logs. The backend echoes the "bearer" subprotocol on accept.
      ws = new WebSocket(`${proto}://${location.host}/ws`, ['bearer', token])

      ws.onopen = () => setConnected(true)
      ws.onclose = (ev) => {
        setConnected(false)
        if (closed) return
        if (ev.code === WS_AUTH_FAILED) {
          // Dead session: stop retrying and force a clean logout instead of
          // reconnecting forever with a rejected token.
          closed = true
          notifyAuthFailure()
          return
        }
        retry = setTimeout(connect, 2000)
      }
      ws.onerror = () => ws?.close()
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as WsMessage
          if (msg.event === 'status') handlers.current.onStatus?.(msg.data)
          handlers.current.onEvent?.(msg)
        } catch {
          /* ignore malformed frames */
        }
      }
    }

    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      ws?.close()
    }
  }, [])

  return { connected }
}
