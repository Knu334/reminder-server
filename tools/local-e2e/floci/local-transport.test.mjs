import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { pinnedRequest, cleanBucketVersions } from './local-transport.mjs';

test('validated IPv4 binding survives hostname DNS drift and preserves service Host', async () => {
  // System localhost resolves to 127.0.0.1/::1, but our validated snapshot is 127.0.0.2.
  const server = createServer((req, res) => {
    res.setHeader('set-cookie', ['session=synthetic; HttpOnly', 'csrf=synthetic; SameSite=Lax']);
    res.end(req.headers.host);
  });
  server.listen(0, '127.0.0.2'); await once(server, 'listening');
  const port = server.address().port;
  try {
    const response = await pinnedRequest(new URL(`http://localhost:${port}/`), {}, new Map([['localhost', '127.0.0.2']]));
    assert.equal(response.status, 200);
    assert.equal(response.bytes.toString(), `localhost:${port}`);
    assert.equal(response.headers.getSetCookie().length, 2);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('one S3 version failure cannot skip other versions, markers, pages or bucket attempt', async () => {
  class ListObjectVersionsCommand { constructor(input) { this.input = input; } }
  class DeleteObjectCommand { constructor(input) { this.input = input; } }
  class DeleteBucketCommand { constructor(input) { this.input = input; } }
  const commands = { ListObjectVersionsCommand, DeleteObjectCommand, DeleteBucketCommand };
  const seen = [];
  const client = { async send(command) {
    if (command instanceof ListObjectVersionsCommand) {
      return command.input.KeyMarker ? { Versions: [{ Key: 'b', VersionId: 'v2' }] }
        : { Versions: [{ Key: 'a', VersionId: 'v1' }], DeleteMarkers: [{ Key: 'a', VersionId: 'm1' }],
          IsTruncated: true, NextKeyMarker: 'b', NextVersionIdMarker: 'v2' };
    }
    if (command instanceof DeleteObjectCommand) {
      seen.push(command.input.VersionId);
      if (command.input.VersionId === 'v1') throw new Error('synthetic version deletion failure');
    } else { seen.push('bucket'); throw new Error('synthetic bucket remains nonempty'); }
  } };
  let failure;
  try { await cleanBucketVersions(client, commands, 'owned-synthetic'); } catch (error) { failure = error; }
  assert.deepEqual(seen, ['v1', 'm1', 'v2', 'bucket']);
  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.errors.length, 2);
});
