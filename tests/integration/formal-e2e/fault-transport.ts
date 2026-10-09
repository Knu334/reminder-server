import type { S3ClientConfig } from '@aws-sdk/client-s3';

/** The handler type the SDK client config accepts (not a bare object of options), so a faulted handler plugs into any product client unchanged. */
export type RequestHandler = Extract<NonNullable<S3ClientConfig['requestHandler']>, { handle: (...args: never[]) => unknown }>;
type Request = Parameters<RequestHandler['handle']>[0]; type Options = Parameters<RequestHandler['handle']>[1];
export type FaultRule = { command: string; occurrence: number; phase: 'before' | 'after' | 'delay'; effect: 'throw' | 'abort' };
export type FaultTrace = { command: string; occurrence: number; phase: string };

type Wire = { method: string; hostname: string; path: string; query?: Record<string, unknown>; headers?: Record<string, unknown> };
const target = (request: Wire): string => String(request.headers?.['x-amz-target'] ?? '');
const dynamo = (name: string) => (request: Wire): boolean => request.hostname.startsWith('dynamodb.') && target(request).endsWith(`.${name}`);
const s3Host = (request: Wire): boolean => request.hostname.startsWith('s3.') || request.hostname.includes('.s3.');
/** Object key length in path segments: virtual-hosted style (bucket in the host) and path style (bucket first) both occur, by bucket name. */
const keySegments = (request: Wire): number => request.path.split('/').filter(Boolean).length - (/^[^.]+\.s3\./.test(request.hostname) ? 0 : 1);
const versioned = (request: Wire): boolean => request.query?.versionId !== undefined;
/**
 * The explicit SDK command table. A rule names one of these SDK operation names; a request that no entry claims is rejected
 * (fail closed), so a fault can never silently miss, and a version-pinned delete is its own command that no actor may send.
 */
export const COMMANDS: Readonly<Record<string, (request: Wire) => boolean>> = {
  GetItem: dynamo('GetItem'), PutItem: dynamo('PutItem'), UpdateItem: dynamo('UpdateItem'), DeleteItem: dynamo('DeleteItem'), Query: dynamo('Query'), Scan: dynamo('Scan'), TransactWriteItems: dynamo('TransactWriteItems'),
  HeadObject: request => s3Host(request) && request.method === 'HEAD' && keySegments(request) >= 1,
  HeadBucket: request => s3Host(request) && request.method === 'HEAD' && keySegments(request) <= 0,
  GetObject: request => s3Host(request) && request.method === 'GET' && keySegments(request) >= 1 && request.query?.versions === undefined,
  ListObjectVersions: request => s3Host(request) && request.method === 'GET' && request.query?.versions !== undefined,
  PutObject: request => s3Host(request) && request.method === 'PUT' && keySegments(request) >= 1,
  DeleteObject: request => s3Host(request) && request.method === 'DELETE' && keySegments(request) >= 1 && !versioned(request),
  DeleteObjectVersion: request => s3Host(request) && request.method === 'DELETE' && keySegments(request) >= 1 && versioned(request),
  DeleteObjects: request => s3Host(request) && request.method === 'POST' && request.query?.delete !== undefined,
  PutMetricData: request => request.hostname.startsWith('monitoring.') && target(request).endsWith('.PutMetricData'),
};
export function commandOf(request: Wire): string | undefined { return Object.entries(COMMANDS).find(([, matches]) => matches(request))?.[0]; }
const failure = (rule: FaultRule): Error => Object.assign(new Error(`synthetic ${rule.phase} fault`), { name: rule.effect === 'abort' ? 'AbortError' : 'TimeoutError' });

/**
 * Wraps a request handler with deterministic faults. before: the request never reaches the delegate (a send-side failure).
 * after: the delegate really processes the request and the response is then lost. delay: the request is held, unsent, until the
 * SDK's own abort signal fires. The trace holds only the fixed command name, its per-command occurrence and the phase: never a
 * header, URL, query or body.
 */
export function createFaultTransport(delegate: RequestHandler, rules: readonly FaultRule[]): { handler: RequestHandler; trace: ReadonlyArray<FaultTrace> } {
  const seen = new Set<string>();
  for (const rule of rules) {
    const key = `${rule.command}#${rule.occurrence}`;
    if (!Object.hasOwn(COMMANDS, rule.command) || !Number.isSafeInteger(rule.occurrence) || rule.occurrence < 1 || !['before', 'after', 'delay'].includes(rule.phase) || !['throw', 'abort'].includes(rule.effect) || seen.has(key)) throw new Error('FAULT_RULE_REJECTED');
    seen.add(key);
  }
  const counts = new Map<string, number>(); const trace: FaultTrace[] = [];
  const handler = {
    metadata: { handlerProtocol: 'http/1.1' },
    destroy(): void { (delegate as { destroy?: () => void }).destroy?.(); },
    async handle(request: Request, options?: Options) {
      const wire = request as unknown as Wire; const command = commandOf(wire); if (command === undefined) throw new Error('FAULT_COMMAND_UNMAPPED');
      const occurrence = (counts.get(command) ?? 0) + 1; counts.set(command, occurrence);
      const rule = rules.find(item => item.command === command && item.occurrence === occurrence);
      if (!rule) { trace.push({ command, occurrence, phase: 'pass' }); return delegate.handle(request, options); }
      trace.push({ command, occurrence, phase: rule.phase });
      if (rule.phase === 'before') throw failure(rule);
      if (rule.phase === 'delay') {
        const signal = (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal; if (!signal) throw failure(rule);
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
        throw failure(rule);
      }
      await delegate.handle(request, options); throw failure(rule);
    },
  };
  return { handler: handler as unknown as RequestHandler, trace };
}
