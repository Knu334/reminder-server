import http from 'node:http';
import { isIP } from 'node:net';
import type { HttpResult, LocalTarget } from './types.ts';

export function isPrivateIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}

export async function localRequest(target: LocalTarget, url: URL, options: { method?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<HttpResult> {
  // The map is a discovery snapshot. Never resolve again at socket creation.
  const address = target.addresses.get(url.hostname);
  const primary = target.addresses.get('floci');
  if (target.endpoint !== 'http://floci:4566' || target.region !== 'ap-northeast-1' ||
      !primary || !isPrivateIPv4(primary) || address !== primary || url.protocol !== 'http:' ||
      url.port !== '4566' || url.username || url.password || url.hash ||
      Object.keys(options.headers ?? {}).some(name => ['host', 'connection', 'proxy-authorization'].includes(name.toLowerCase()))) {
    throw new Error('LOCAL_TARGET_REJECTED');
  }
  return new Promise((resolve, reject) => {
    let completed = false;
    const fail = () => { if (!completed) { completed = true; reject(new Error('LOCAL_REQUEST_FAILED')); } };
    try {
      const outgoing = http.request(url, {
        method: options.method ?? 'GET', headers: { ...options.headers, host: url.host }, agent: false,
        signal: AbortSignal.timeout(30_000),
        lookup: (_host, lookupOptions, callback) => lookupOptions.all
          ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
      }, response => {
        const chunks: Buffer[] = []; let length = 0; const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 16 * 1024 * 1024) { fail(); outgoing.destroy(); } else chunks.push(chunk);
        });
        response.on('error', fail);
        response.on('aborted', fail);
        response.on('end', () => {
          if (!completed) { completed = true; resolve({ status: response.statusCode ?? 0, headers, bytes: Buffer.concat(chunks) }); }
        });
      });
      outgoing.on('error', fail);
      // 3xx is returned for explicit OAuth inspection; no redirect is ever followed.
      outgoing.end(options.body);
    } catch { fail(); }
  });
}
