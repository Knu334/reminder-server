import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import type { STSClient } from '@aws-sdk/client-sts';
import type { Config } from '../../../../src/config.ts';

export type Layer = 'U' | 'I' | 'E' | 'L' | 'A';
export type CaseStatus = 'pass' | 'fail' | 'not-run' | 'unsupported' | 'out-of-scope';
export type OutputKind = 'http' | 'dynamodb' | 's3' | 'logs';
export type OutputExpectation = { kind: OutputKind; assertions: string[]; notApplicableReason?: string };
export type OutputResult = { kind: OutputKind; status: 'pass' | 'fail' | 'not-applicable'; assertions: { name: string; status: 'pass' | 'fail' }[]; reason?: string };
export type CaseDefinition = { id: string; requirementId: string; layer: Layer; required: boolean; acceptance: 'behavior' | 'compatibility'; suite: string; source: string; outputs: OutputExpectation[] };
export type CaseResult = { id: string; status: CaseStatus; phase: string; httpStatus?: number; code?: string; durationMs: number; outputs?: OutputResult[]; reason?: string };
export interface Evidence {
  runId: string;
  record(result: CaseResult): Promise<void>;
  finish(cleanup: CleanupSummary): Promise<RunSummary>;
}
export type CleanupSummary = { attempted: number; succeeded: number; errors: number; leaks: number };
export type RunSummary = { selected: number; passed: number; failed: number; notRun: number; unsupported: number; outOfScope: number; cleanup: CleanupSummary; exitCode: 0 | 1 | 2 };
export type LocalTarget = { endpoint: 'http://floci:4566'; region: 'ap-northeast-1'; addresses: ReadonlyMap<string, string> };
export type HttpResult = { status: number; headers: Headers; bytes: Buffer };
export type ArtifactSnapshot = { zipPath: string; sha256Hex: string; sha256Base64: string; compressedBytes: number; inputDigest: string; dirtyPaths: string[] };
export type FixtureOptions = { publication: boolean };
export type SuiteOptions = { suite: string; publication: boolean };
export type OwnedManifest = { runId: string; resources: { kind: string; name: string; id: string; created: boolean; removed: boolean }[] };
// Task4 replaces this temporary structural port with the pinned CloudWatchLogsClient.
// No implementation or fallback client is supplied by the Task1 foundation.
export interface CloudWatchLogsPort { send(command: unknown): Promise<unknown> }
export type LocalClients = { dynamodb: DynamoDBDocumentClient; s3: S3Client; lambda: LambdaClient; cloudwatch: CloudWatchClient; logs: CloudWatchLogsPort; sts: STSClient };
export type AuthSession = { accessToken: string; idToken?: string; refreshToken: string; claims: { iss: string; sub: string; client_id: string; iat: number; exp: number; scope: string } };
export type FixtureAuth = {
  login(owner: 'a' | 'b', scopes: string[], client: 'primary' | 'sibling' | 'foreign'): Promise<AuthSession>;
  refresh(session: AuthSession): Promise<AuthSession>;
};
export type E2EFixture = {
  target: LocalTarget; prefix: string; config: Config; artifact: ArtifactSnapshot; manifest: OwnedManifest;
  clients: LocalClients; auth: FixtureAuth;
  request(path: string, options?: { token?: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<HttpResult>;
  setPublication(published: boolean): Promise<void>;
  resetSuite(): Promise<CleanupSummary>;
  dispose(): Promise<CleanupSummary>;
};
export type SuiteFixture = Omit<E2EFixture, 'dispose'>;
export type PreparedTerraformRoots = {
  bootstrap: string; platform: string; application: string; sourceDigest: string; transformedDigest: string;
  validationDiffs: { location: string; kind: 'owned-url-validation' }[];
  generatedChanges: { category: 'connection' | 'isolation' | 'cleanup'; destinations: string[] }[];
};
export type ProvisionedStack = {
  target: LocalTarget; artifact: ArtifactSnapshot; manifest: OwnedManifest;
  bindings: Readonly<Record<string, string>>; stateDirectory: string;
  destroy(): Promise<CleanupSummary>;
};
export type LogExpectation = { service: 'api' | 'gateway' | 'cleanup'; requestId?: string; lambdaRequestId?: string; since: number; mode: 'present' | 'absent'; until?: number; status?: number; operation?: string; code?: string };
export type SafeLogMatch = { service: LogExpectation['service']; events: number; status?: number; operation?: string; code?: string };
export type PendingLogCheck = { caseId: string; assertion: string; expectation: LogExpectation; controls?: { before: LogExpectation; after: LogExpectation } };
export type LogCheckResult = { caseId: string; assertion: string; matched: boolean; controlsMatched?: { before: boolean; after: boolean } };
export type CaseRecorder = {
  recordOutput(result: OutputResult): void;
  deferLogs(check: PendingLogCheck): void;
  /** Call immediately after input; data is projected onto the evidence allowlist. */
  recordInput(input: { httpStatus?: number; code?: string }): void;
};
