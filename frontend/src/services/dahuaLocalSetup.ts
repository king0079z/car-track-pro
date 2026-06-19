/**
 * Browser → camera HTTP (shop LAN / camera AP). Use when the PC/phone is on the
 * same network as the camera. Bypasses the cloud VPS which cannot reach 192.168.x.
 */

export type LocalWifiNetwork = { ssid: string; bssid: string; intensity: number };

/** Keep browser calls short — unreachable private IPs can hang 60s+ without a timeout. */
const CAM_FETCH_MS = 5000;

function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function parseWlanScan(text: string): LocalWifiNetwork[] {
  const kv = parseKv(text);
  const indices = new Set<number>();
  for (const k of Object.keys(kv)) {
    const m = /^wlanDevice\[(\d+)\]\./i.exec(k);
    if (m) indices.add(Number(m[1]));
  }
  const nets: LocalWifiNetwork[] = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    const ssid = kv[`wlanDevice[${i}].SSID`] || kv[`wlanDevice[${i}].ssid`];
    if (!ssid) continue;
    const bssid = kv[`wlanDevice[${i}].BSSID`] || kv[`wlanDevice[${i}].bssid`] || '';
    let q = 0;
    try {
      q = Number(kv[`wlanDevice[${i}].LinkQuality`] || kv[`wlanDevice[${i}].RSSIQuality`] || 0);
    } catch {
      q = 0;
    }
    nets.push({ ssid, bssid, intensity: Math.min(5, Math.max(0, Math.round(q / 6))) });
  }
  return nets;
}

async function camGet(
  host: string,
  path: string,
  user = 'admin',
  pass = '',
  timeoutMs = CAM_FETCH_MS,
): Promise<{ ok: boolean; status: number; text: string; timedOut?: boolean; opaque?: boolean }> {
  const url = `http://${host}${path}`;
  const headers: Record<string, string> = {};
  if (user || pass) headers.Authorization = `Basic ${btoa(`${user}:${pass}`)}`;

  const attempt = async (mode: RequestMode) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'GET', headers, mode, signal: controller.signal });
      if (mode === 'no-cors') {
        return { ok: true, status: 0, text: '', opaque: true };
      }
      const text = await res.text();
      return { ok: res.ok, status: res.status, text, opaque: false };
    } catch (e) {
      const timedOut = e instanceof DOMException && e.name === 'AbortError';
      return { ok: false, status: 0, text: timedOut ? 'timeout' : String(e), timedOut, opaque: mode === 'no-cors' };
    } finally {
      window.clearTimeout(timer);
    }
  };

  const cors = await attempt('cors');
  if (cors.ok || cors.status > 0) return cors;
  // Dahua cameras rarely send CORS headers — no-cors still delivers the HTTP GET.
  const opaque = await attempt('no-cors');
  if (opaque.ok) return opaque;
  return cors;
}

export async function browserProbeCamera(host: string, password = ''): Promise<{ ok: boolean; serial?: string; error?: string }> {
  for (const pwd of [password, '']) {
    const r = await camGet(host, '/cgi-bin/magicBox.cgi?action=getSerialNo', 'admin', pwd);
    if (r.ok && /serialNumber/i.test(r.text)) {
      const m = /serialNumber=([^\r\n]+)/i.exec(r.text);
      return { ok: true, serial: (m?.[1] || '').trim().toUpperCase() };
    }
  }
  return {
    ok: false,
    error: `Cannot reach camera at ${host}. Join the camera hotspot Dahua_XXXX (192.168.1.108) or shop Wi‑Fi on this device.`,
  };
}

export async function browserScanWifi(host: string, password = ''): Promise<{ ok: boolean; networks: LocalWifiNetwork[]; error?: string }> {
  for (const pwd of [password, '']) {
    const r = await camGet(host, '/cgi-bin/wlan.cgi?action=scanWlanDevices', 'admin', pwd, 12000);
    if (r.opaque) {
      return {
        ok: false,
        networks: [],
        error: 'Camera responded but browser blocked reading the scan (CORS). Type your Wi‑Fi name manually, or use the CarTrack app on the same network.',
      };
    }
    if (r.ok) return { ok: true, networks: parseWlanScan(r.text) };
  }
  return { ok: false, networks: [], error: 'Wi‑Fi scan failed — join the camera hotspot Dahua_XXXX on this phone/PC first.' };
}

export async function browserConnectWifi(
  host: string,
  ssid: string,
  wifiPassword: string,
  devicePassword = '',
): Promise<{ ok: boolean; error?: string }> {
  const iface = 'eth2';
  const enc = wifiPassword ? 'WPA-PSK-CCMP' : 'Off';
  const params = new URLSearchParams({
    [`WLan.${iface}.Enable`]: 'true',
    [`WLan.${iface}.SSID`]: ssid,
    [`WLan.${iface}.LinkMode`]: 'Infrastructure',
    [`WLan.${iface}.Encryption`]: enc,
    [`WLan.${iface}.KeyFlag`]: wifiPassword ? 'true' : 'false',
    [`WLan.${iface}.KeyID`]: '0',
    [`WLan.${iface}.KeyType`]: 'ASCII',
    [`WLan.${iface}.Keys[0]`]: wifiPassword,
  });
  const path = `/cgi-bin/configManager.cgi?action=setConfig&${params.toString()}`;
  for (const pwd of [devicePassword, '']) {
    const r = await camGet(host, path, 'admin', pwd, 15000);
    if (r.opaque) {
      return {
        ok: true,
        error: undefined,
      };
    }
    if (r.ok && /OK/i.test(r.text)) return { ok: true };
  }
  return {
    ok: false,
    error: 'Could not send Wi‑Fi settings. Join hotspot Dahua_XXXX (IP 192.168.1.108) on this device, then try again.',
  };
}

export async function browserProbeAnyHost(
  hosts: string[],
  password = '',
): Promise<{ ok: boolean; host?: string; serial?: string }> {
  const results = await Promise.all(
    hosts.map(async h => {
      const r = await browserProbeCamera(h, password);
      return { host: h, ...r };
    }),
  );
  const hit = results.find(r => r.ok);
  if (hit) return { ok: true, host: hit.host, serial: hit.serial };
  return { ok: false };
}

export const DEFAULT_CAMERA_HOSTS = ['192.168.1.108', '192.168.0.108', '192.168.1.1'];
