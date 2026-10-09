import { Readable } from 'node:stream';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { HttpResponse } from '@smithy/core/protocols';
import type { createHarness } from '../../support/stateful-store';
import type { RequestHandler } from './fault-transport.ts';

/**
 * Stateful wire-level stand-ins for the three services the cleanup Lambda talks to: DynamoDB (JSON 1.0), S3 (REST) and CloudWatch.
 * They sit under the real SDK clients and the real product adapters and decode the actual requests; the data lives in the synthetic
 * command-level harness. They are test doubles only: no claim about Floci, real DynamoDB or S3 behaviour follows from them.
 */
type Harness = ReturnType<typeof createHarness>;
type Wire = { method: string; hostname: string; path: string; query?: Record<string, unknown>; headers?: Record<string, unknown>; body?: unknown };
const reply = (statusCode: number, headers: Record<string, string> = {}, body = ''): { response: HttpResponse } => ({ response: new HttpResponse({ statusCode, headers, body: Readable.from(body ? [Buffer.from(body)] : []) }) });
const text = (body: unknown): string => typeof body === 'string' ? body : body instanceof Uint8Array ? Buffer.from(body).toString('utf8') : '';
const json = (headers: Record<string, string> = {}): Record<string, string> => ({ 'content-type': 'application/x-amz-json-1.0', ...headers });
const budget = () => ({ signal: new AbortController().signal, remainingMs: () => 10_000 });
const un = (value: unknown): Record<string, unknown> | undefined => value === undefined ? undefined : unmarshall(value as never);
const mar = (value: unknown): unknown => marshall(value as never, { removeUndefinedValues: true });

export function wireFakes(h: Harness) {
  const permanentDeletes: { key: string; versionId: string }[] = []; const metrics: string[][] = [];
  const dynamodb = { async handle(request: Wire) {
    const operation = String(request.headers?.['x-amz-target']).split('.').at(-1); const input = JSON.parse(text(request.body)) as Record<string, unknown>;
    const common = { TableName: input.TableName as string, ...(input.ConditionExpression ? { ConditionExpression: input.ConditionExpression as string } : {}), ...(input.ExpressionAttributeNames ? { ExpressionAttributeNames: input.ExpressionAttributeNames as Record<string, string> } : {}), ...(input.ExpressionAttributeValues ? { ExpressionAttributeValues: un(input.ExpressionAttributeValues)! } : {}) };
    try {
      if (operation === 'GetItem') { const out = await h.client.send(new GetCommand({ TableName: common.TableName, Key: un(input.Key)! })) as { Item?: unknown }; return reply(200, json(), JSON.stringify(out.Item ? { Item: mar(out.Item) } : {})); }
      if (operation === 'PutItem') { await h.client.send(new PutCommand({ ...common, Item: un(input.Item)! })); return reply(200, json(), '{}'); }
      if (operation === 'UpdateItem') { const out = await h.client.send(new UpdateCommand({ ...common, Key: un(input.Key)!, UpdateExpression: input.UpdateExpression as string, ...(input.ReturnValues ? { ReturnValues: input.ReturnValues as 'ALL_NEW' } : {}) })) as { Attributes?: unknown }; return reply(200, json(), JSON.stringify(out.Attributes ? { Attributes: mar(out.Attributes) } : {})); }
      if (operation === 'Query') { const out = await h.client.send(new QueryCommand({ ...common, ...(input.IndexName ? { IndexName: input.IndexName as string } : {}), ...(input.Limit ? { Limit: input.Limit as number } : {}), KeyConditionExpression: input.KeyConditionExpression as string, ...(input.ExclusiveStartKey ? { ExclusiveStartKey: un(input.ExclusiveStartKey)! } : {}) })) as { Items?: unknown[]; ScannedCount?: number; LastEvaluatedKey?: unknown };
        return reply(200, json(), JSON.stringify({ Items: (out.Items ?? []).map(mar), Count: out.Items?.length ?? 0, ScannedCount: out.ScannedCount ?? 0, ...(out.LastEvaluatedKey ? { LastEvaluatedKey: mar(out.LastEvaluatedKey) } : {}) })); }
      if (operation === 'DeleteItem') { await h.client.send(new DeleteCommand({ TableName: common.TableName, Key: un(input.Key)! })); return reply(200, json(), '{}'); }
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      if (name === 'ConditionalCheckFailedException') return reply(400, json({ 'x-amzn-errortype': name }), JSON.stringify({ __type: `com.amazonaws.dynamodb.v20120810#${name}`, message: 'The conditional request failed' }));
      return reply(500, json({ 'x-amzn-errortype': 'InternalServerError' }), JSON.stringify({ __type: 'com.amazonaws.dynamodb.v20120810#InternalServerError', message: 'synthetic server failure' }));
    }
    return reply(400, json(), JSON.stringify({ __type: 'com.amazon.coral.service#UnknownOperationException', message: 'unsupported' }));
  } } as unknown as RequestHandler;
  const s3 = { async handle(request: Wire) {
    const parts = request.path.split('/').filter(Boolean); const key = decodeURIComponent((/^[^.]+\.s3\./.test(request.hostname) ? parts : parts.slice(1)).join('/')); const versionId = request.query?.versionId === undefined ? null : String(request.query.versionId);
    if (request.method === 'HEAD') {
      const head = await h.images.head(key, versionId, budget()); if (head === null) return reply(404);
      if (head.deleteMarker) return reply(404, { 'x-amz-delete-marker': 'true', 'x-amz-version-id': head.versionId });
      return reply(200, { 'x-amz-version-id': head.versionId, ...(head.sha256 ? { 'x-amz-checksum-sha256': Buffer.from(head.sha256, 'hex').toString('base64') } : {}), 'content-length': '0' });
    }
    if (request.method === 'DELETE') {
      if (versionId !== null) { permanentDeletes.push({ key, versionId }); return reply(204); }
      await h.images.markDeleted(key, budget()); const marker = h.imageDeleteMarkers().find(item => item.key === key)!;
      return reply(204, { 'x-amz-delete-marker': 'true', 'x-amz-version-id': marker.versionId });
    }
    return reply(405);
  } } as unknown as RequestHandler;
  const cloudwatch = { async handle(request: Wire) {
    const body = JSON.parse(text(request.body)) as { MetricData?: { MetricName?: string }[] }; metrics.push((body.MetricData ?? []).map(datum => String(datum.MetricName)));
    return reply(200, json(), '{}');
  } } as unknown as RequestHandler;
  return { dynamodb, s3, cloudwatch, permanentDeletes, metrics };
}
