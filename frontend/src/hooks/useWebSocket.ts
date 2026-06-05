import { useEffect, useRef } from 'react';
import { WS_URL } from '../services/api';
import { reportWebSocketFault } from '../services/clientErrorReporter';

type MessageHandler = (data: any) => void;

// Module-level singleton — survives StrictMode double-invoke
let globalWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
/** Avoid duplicate audit rows when `error` is followed immediately by `close`. */
let wsReportedErrorEvent = false;
const listeners = new Set<MessageHandler>();

function connectSingleton() {
  if (globalWs && (globalWs.readyState === WebSocket.CONNECTING || globalWs.readyState === WebSocket.OPEN)) {
    return;
  }

  const token = localStorage.getItem('cartrack_token');
  if (!token) return;

  try {
    const ws = new WebSocket(WS_URL);
    globalWs = ws;

    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25000);

    ws.onopen = () => {
      clearTimeout(reconnectTimer);
      wsReportedErrorEvent = false;
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type !== 'pong') {
          listeners.forEach(fn => { try { fn(data); } catch { /* ignore */ } });
        }
      } catch { /* ignore */ }
    };

    ws.onclose = ev => {
      clearInterval(ping);
      globalWs = null;
      if (!wsReportedErrorEvent) {
        reportWebSocketFault({ phase: 'close', code: ev.code, reason: ev.reason });
      }
      wsReportedErrorEvent = false;
      reconnectTimer = setTimeout(connectSingleton, 5000);
    };

    ws.onerror = () => {
      wsReportedErrorEvent = true;
      reportWebSocketFault({ phase: 'error' });
      ws.close();
    };
  } catch {
    reconnectTimer = setTimeout(connectSingleton, 5000);
  }
}

export function useWebSocket(onMessage?: MessageHandler) {
  const cbRef = useRef<MessageHandler | undefined>(onMessage);

  // Keep callback fresh
  useEffect(() => { cbRef.current = onMessage; }, [onMessage]);

  useEffect(() => {
    // Stable wrapper that always calls the latest cbRef
    const handler: MessageHandler = (data) => { cbRef.current?.(data); };

    if (onMessage) listeners.add(handler);

    // Boot connection if not already running
    connectSingleton();

    return () => {
      listeners.delete(handler);
      // Don't close on unmount — singleton stays alive
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = (data: any) => {
    if (globalWs?.readyState === WebSocket.OPEN) {
      globalWs.send(JSON.stringify(data));
    }
  };

  return { send };
}
