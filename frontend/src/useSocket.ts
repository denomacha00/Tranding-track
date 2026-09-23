import { useEffect, useRef, useState } from 'react'
import type { BotStatus, WsMessage } from './types'

type Handlers = {
  onStatus?: (s: BotStatus) => void
  onEvent?: (m: WsMessage) => void
}

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
      ws = new WebSocket(`${proto}://${location.host}/ws`)

      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        if (!closed) retry = setTimeout(connect, 2000)
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
