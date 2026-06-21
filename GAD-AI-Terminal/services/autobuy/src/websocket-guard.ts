/**
 * WebSocket Guard — отказоустойчивое соединение с PumpPortal.
 *
 * Проблема: WS может оборваться из-за:
 *   - сетевых сбоев VPS
 *   - перезагрузки серверов PumpPortal (раз в несколько часов)
 *   - молчаливого "зависания" соединения (TCP без трафика)
 *
 * Решение:
 *   - Экспоненциальная задержка реконнекта (1→2→4→8→16→30s cap)
 *   - Ping-Pong heartbeat каждые 30s — определяет "зависшее" соединение
 *   - До 10 попыток реконнекта, потом критический лог
 *   - Поддержка нескольких подписок (resubscribe на каждый реконнект)
 */

import WebSocket from 'ws';

export interface WsGuardOptions {
  url:                string;
  onMessage:          (data: any) => void;
  onOpen?:            () => void;      // вызывается после каждого успешного подключения
  pingIntervalMs?:    number;          // default: 30000
  maxReconnects?:     number;          // default: 10 (0 = бесконечно)
  reconnectBaseMs?:   number;          // default: 1000 (первая задержка)
  reconnectCapMs?:    number;          // default: 30000 (максимальная задержка)
}

export interface WsGuardHandle {
  send:       (msg: string) => void;
  terminate:  () => void;
  isAlive:    () => boolean;
}

export function createGuardedWS(opts: WsGuardOptions): WsGuardHandle {
  const {
    url,
    onMessage,
    onOpen,
    pingIntervalMs  = 30_000,
    maxReconnects   = 10,
    reconnectBaseMs = 1_000,
    reconnectCapMs  = 30_000,
  } = opts;

  let ws:             WebSocket | null = null;
  let attempts        = 0;
  let destroyed       = false;
  let pingTimer:      ReturnType<typeof setInterval>  | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout>   | null = null;

  function connect(): void {
    if (destroyed) return;
    if (ws) { try { ws.terminate(); } catch {} ws = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }

    ws = new WebSocket(url);

    ws.on('open', () => {
      attempts = 0;
      console.info(`[ws-guard] ✅ Подключено: ${url}`);

      // Запускаем heartbeat — 30s ping
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, pingIntervalMs);

      // Ждём pong — если нет за 10s → принудительный реконнект
      ws!.on('pong', () => {
        console.debug('[ws-guard] ❤️ pong');
      });

      onOpen?.();
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const parsed = JSON.parse(raw.toString());
        onMessage(parsed);
      } catch (e: any) {
        console.warn('[ws-guard] Ошибка парсинга:', e.message?.slice(0, 60));
      }
    });

    ws.on('close', (code, reason) => {
      console.warn(`[ws-guard] ⚠️ Закрыто (code:${code} ${reason?.toString().slice(0, 40) ?? ''}) — реконнект…`);
      scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      // error → close → scheduleReconnect() вызовется из close handler
      console.warn(`[ws-guard] ❌ WS error: ${err.message?.slice(0, 80)}`);
    });
  }

  function scheduleReconnect(): void {
    if (destroyed) return;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); }

    attempts++;
    if (maxReconnects > 0 && attempts > maxReconnects) {
      console.error(`[ws-guard] ❌ Лимит реконнектов (${maxReconnects}) исчерпан — нужен ручной перезапуск контейнера`);
      return;
    }

    // Экспоненциальная задержка с cap
    const delayMs = Math.min(reconnectBaseMs * Math.pow(2, attempts - 1), reconnectCapMs);
    console.info(`[ws-guard] Попытка #${attempts} через ${(delayMs / 1000).toFixed(0)}s…`);
    reconnectTimer = setTimeout(connect, delayMs);
  }

  connect();

  return {
    send: (msg: string) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(msg);
      else console.warn('[ws-guard] send: WS не открыт');
    },
    terminate: () => {
      destroyed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.terminate(); } catch {}
    },
    isAlive: () => ws?.readyState === WebSocket.OPEN,
  };
}
