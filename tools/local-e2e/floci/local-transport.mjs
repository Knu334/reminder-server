import assert from 'node:assert/strict';
import { request } from 'node:http';
import { isIP } from 'node:net';

export async function pinnedRequest(url, options, addresses) {
  const address = addresses.get(url.hostname);
  assert.ok(url.protocol === 'http:' && isIP(address) === 4, 'HTTP transport requires a validated pinned IPv4 address');
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method: options.method ?? 'GET', headers: options.headers,
      signal: AbortSignal.timeout(30000),
      // Keep the original URL/Host while binding the socket to the validated IPv4 snapshot.
      lookup: (_host, lookupOptions, callback) => lookupOptions.all
        ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4),
    }, (response) => {
      const chunks = [], headers = new Headers();
      for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers, bytes: Buffer.concat(chunks) }));
    });
    outgoing.on('error', reject);
    outgoing.end(options.body instanceof URLSearchParams ? options.body.toString() : options.body);
  });
}

export async function cleanBucketVersions(client, commands, bucket) {
  const errors = [];
  let KeyMarker, VersionIdMarker;
  try { do {
    const page = await client.send(new commands.ListObjectVersionsCommand({ Bucket: bucket, KeyMarker, VersionIdMarker }));
    for (const value of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
      try { await client.send(new commands.DeleteObjectCommand({ Bucket: bucket, Key: value.Key, VersionId: value.VersionId })); }
      catch (error) { errors.push(error); }
    }
    KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    VersionIdMarker = page.NextVersionIdMarker;
  } while (KeyMarker); } catch (error) { errors.push(error); }
  try { await client.send(new commands.DeleteBucketCommand({ Bucket: bucket })); }
  catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Owned S3 cleanup failures');
}
