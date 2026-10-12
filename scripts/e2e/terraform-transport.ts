import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { LocalTarget } from '../../tests/e2e/floci/support/types.ts';
import { assertLocalTarget } from './terraform-source.ts';

export async function withTerraformTransport<T>(target: LocalTarget, action: (proxy: string) => Promise<T>, control?: { accountId: string; buckets: string[] }): Promise<{ value: T; denied: string[]; blockedEndpointCounts: Record<string, number>; forwarded: number }> {
  const address = assertLocalTarget(target);
  if (control && (!/^\d{12}$/.test(control.accountId) || control.buckets.some(bucket=>!/^e2e-[a-z0-9-]+$/.test(bucket)))) throw new Error('RELAY_OWNERSHIP_REJECTED');
  const token = randomBytes(24).toString('hex'); const authentication = 'Basic ' + Buffer.from(`e2e:${token}`).toString('base64'); const denied: string[] = []; let forwarded = 0;
  const blockedEndpointCounts: Record<string, number> = {};
  const block = (kind: string) => { blockedEndpointCounts[kind] = (blockedEndpointCounts[kind] ?? 0) + 1; if (denied.length < 128) denied.push(kind); };
  const classify = (host: string) => {
    const known: Record<string,string> = { 's3.amazonaws.com':'aws-s3', 's3.ap-northeast-1.amazonaws.com':'aws-s3-regional', 's3-control.ap-northeast-1.amazonaws.com':'aws-s3-control', 'sts.amazonaws.com':'aws-sts', 'iam.amazonaws.com':'aws-iam', 'tagging.ap-northeast-1.amazonaws.com':'aws-tagging', 'registry.terraform.io':'terraform-registry' };
    if (host === address || target.addresses.get(host) === address) return 'owned-host-https';
    if (host === '000000000000.floci') return 'synthetic-account-floci-alias';
    if (host.endsWith('.floci')) return 'unverified-floci-alias';
    if (host.endsWith('.localhost.localstack.cloud')) return 'unverified-localstack-alias';
    if (host === 'www.w3.org') return 'public-xml-schema';
    if (host === 's3.amazonaws.com') return 'aws-s3';
    return known[host] ?? (host.endsWith('.amazonaws.com') ? 'aws-other' : 'unowned-host');
  };
  const server = http.createServer((request, response) => {
    if (request.headers['proxy-authorization'] !== authentication) { block('proxy-authentication'); response.writeHead(407).end(); return; }
    let url: URL;
    try { url = new URL(request.url ?? ''); } catch { block('invalid-url'); response.writeHead(403).end(); return; }
    const direct = url.hostname === address || target.addresses.get(url.hostname) === address;
    let accountRelay = false;
    if(control && url.hostname === `${control.accountId}.floci` && request.headers['x-amz-account-id'] === control.accountId){
      const operation = {GET:'ListTagsForResource',POST:'TagResource',DELETE:'UntagResource'}[request.method ?? ''];
      try {
        const path = decodeURIComponent(url.pathname);
        accountRelay = !!operation && control.buckets.some(bucket=>path === `/v20180820/tags/arn:aws:s3:::${bucket}`) && [...url.searchParams].every(([key,value])=>key==='x-id'?value===operation:request.method==='DELETE'&&key==='tagKeys'&&['Project','Environment'].includes(value));
      }catch{/* rejected */}
    }
    if (url.protocol !== 'http:' || url.port !== '4566' || url.username || url.password || url.hash || request.headers.host !== url.host || !(direct || accountRelay)) {
      block(classify(url.hostname)); response.writeHead(403).end(); return;
    }
    forwarded++;
    const outgoing = http.request(url, { method: request.method, headers: Object.fromEntries(Object.entries(request.headers).filter(([name])=>!['proxy-authorization','proxy-connection'].includes(name))), agent: false,
      lookup: (_hostname, options, callback) => options.all ? callback(null,[{address,family:4}]) : callback(null,address,4),
      signal: AbortSignal.timeout(30_000),
    }, incoming => {
      if ((incoming.statusCode ?? 0) >= 300 && (incoming.statusCode ?? 0) < 400) {
        block('redirect'); incoming.resume(); response.writeHead(502).end(); return;
      }
      response.writeHead(incoming.statusCode ?? 502,incoming.headers); incoming.pipe(response);
    });
    outgoing.on('error',()=>{if(!response.headersSent)response.writeHead(502);response.end();});
    request.on('error',()=>outgoing.destroy()); request.pipe(outgoing);
  });
  server.on('connect',(request,socket)=>{if(request.headers['proxy-authorization']!==authentication){block('proxy-authentication');socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');return;}let host='';try{host=new URL(`https://${request.url ?? ''}`).hostname;}catch{/* denied below */}block(classify(host));socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
  const location = server.address(); if(!location || typeof location==='string') throw new Error('TRANSPORT_FAILED');
  try { return { value: await action(`http://e2e:${token}@127.0.0.1:${location.port}`), denied, blockedEndpointCounts, forwarded }; }
  finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
