import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AdminCreateUserCommand, AdminSetUserPasswordCommand, AdminGetUserCommand, AdminDeleteUserCommand, CreateUserPoolClientCommand, DescribeUserPoolClientCommand, DeleteUserPoolClientCommand, CreateUserPoolCommand, CreateResourceServerCommand, DescribeUserPoolCommand, UpdateUserPoolCommand, DeleteUserPoolCommand, ListUserPoolsCommand, ListUserPoolClientsCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { UserPoolClientType, UserPoolType } from '@aws-sdk/client-cognito-identity-provider';
import type { SuiteFixture, FixtureAuth, AuthSession } from './types.ts';
import { fixtureState } from './fixture.ts';
import { reserveResource, markResource, bindResourceIdentities, evidenceContext } from './evidence.ts';
import { discoveredCognitoIdentity } from "../../../../scripts/e2e/terraform-source.ts";
import { localRequest } from './transport.ts';
type User = { pool: string; username: string; password: string; sub: string; intent: string };
type Control = { kind: 'pool' | 'client'; id: string; pool: string; intent: string; name: string };
type AuthState = { cases: Map<string, FixtureAuth>; users: User[]; controls: Control[]; verified: Map<string, 'absent' | 'exists' | 'unverified'> };
const authStates = new WeakMap<object, AuthState>();
function authState(fixture: SuiteFixture): AuthState { const owner = fixtureState(fixture); let state = authStates.get(owner); if (!state) { state = { cases: new Map(), users: [], controls: [], verified: new Map() }; authStates.set(owner, state); } return state; }
const clientInput = (client: UserPoolClientType) => ({ GenerateSecret: false, SupportedIdentityProviders: client.SupportedIdentityProviders, AllowedOAuthFlowsUserPoolClient: client.AllowedOAuthFlowsUserPoolClient, AllowedOAuthFlows: client.AllowedOAuthFlows, AllowedOAuthScopes: client.AllowedOAuthScopes, CallbackURLs: client.CallbackURLs, LogoutURLs: client.LogoutURLs, ExplicitAuthFlows: client.ExplicitAuthFlows, ReadAttributes: client.ReadAttributes, WriteAttributes: client.WriteAttributes, PreventUserExistenceErrors: client.PreventUserExistenceErrors, EnableTokenRevocation: client.EnableTokenRevocation, AccessTokenValidity: client.AccessTokenValidity, IdTokenValidity: client.IdTokenValidity, RefreshTokenValidity: client.RefreshTokenValidity, TokenValidityUnits: client.TokenValidityUnits, RefreshTokenRotation: client.RefreshTokenRotation });
async function bindControl(fixture: SuiteFixture, control: Control): Promise<void> {
  const state = fixtureState(fixture);
  if (!control.id || !control.name.startsWith(`${fixture.prefix}-`)) throw new Error('AUTH_FIXTURE_FAILED');
  const read = control.kind === 'pool' ? (await state.cognito.send(new DescribeUserPoolCommand({ UserPoolId: control.id }))).UserPool?.Name : (await state.cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: control.pool, ClientId: control.id }))).UserPoolClient?.ClientName;
  if (read !== control.name) throw new Error('AUTH_FIXTURE_FAILED');
  await markResource(state.evidence, control.intent, 'created');
  await bindResourceIdentities(state.evidence, control.intent, [{ type: control.kind === 'pool' ? 'aws_cognito_user_pool' : 'aws_cognito_user_pool_client', identity: control.id, ...(control.kind === 'client' ? { parent: control.pool } : {}) }]);
}
async function recoverControl(fixture: SuiteFixture, control: Control): Promise<void> {
  const state = fixtureState(fixture); const matches: string[] = []; let nextToken: string | undefined; const tokens = new Set<string>();
  do {
    if (control.kind === 'pool') {
      const page = await state.cognito.send(new ListUserPoolsCommand({ MaxResults: 60, ...(nextToken ? { NextToken: nextToken } : {}) }));
      for (const item of page.UserPools ?? []) if (item.Name === control.name && item.Id) matches.push(item.Id); nextToken = page.NextToken;
    } else {
      const page = await state.cognito.send(new ListUserPoolClientsCommand({ UserPoolId: control.pool, MaxResults: 60, ...(nextToken ? { NextToken: nextToken } : {}) }));
      for (const item of page.UserPoolClients ?? []) if (item.ClientName === control.name && item.ClientId) matches.push(item.ClientId); nextToken = page.NextToken;
    }
    if (nextToken && tokens.has(nextToken)) throw new Error('AUTH_RECOVERY_FAILED'); if (nextToken) tokens.add(nextToken);
  } while (nextToken);
  // A missing/ambiguous physical ID remains unverified; it never becomes absence.
  if (matches.length !== 1) throw new Error('AUTH_RECOVERY_FAILED'); control.id = matches[0]!; if (control.kind === 'pool') control.pool = control.id; await bindControl(fixture, control);
}
export async function createCaseAuth(fixture: SuiteFixture, caseId: string): Promise<FixtureAuth> {
  if (!/^[A-Za-z0-9/_.-]{1,120}$/.test(caseId)) throw new Error('CASE_REJECTED'); const state = fixtureState(fixture); if (!state.settingsComplete || !state.smokeComplete || state.disposed) throw new Error('PREREQUISITE_FAILED'); const auth = authState(fixture); const existing = auth.cases.get(caseId); if (existing) return existing;
  const primaryPool = state.stack.bindings.pool_id!; const primaryClient = fixture.config.clientId; const serial = auth.cases.size; const users = new Map<string, User>(); const clients = new Map<string, { pool: string; client: string }>([['primary', { pool: primaryPool, client: primaryClient }]]);
  async function createUser(pool: string, owner: 'a' | 'b'): Promise<User> {
    const key = `${pool}/${owner}`; const existing = users.get(key); if (existing) return existing;
    const username = `${fixture.prefix}-${serial}-${owner}-${randomUUID().slice(0, 8)}`; const password = `E2e!${randomBytes(24).toString('base64url')}9a`; const intent = `${state.evidence.runId}/sdk-user/${username}`;
    await reserveResource(state.evidence, { kind: 'sdk-user', name: username, id: intent, suite: state.suite });
    // Keep attempted identity before creation: partial requests may have succeeded.
    const user: User = { pool, username, password, sub: '', intent }; auth.users.push(user);
    await state.cognito.send(new AdminCreateUserCommand({ UserPoolId: pool, Username: username, MessageAction: 'SUPPRESS', UserAttributes: [{ Name: 'email', Value: `${username}@example.test` }, { Name: 'email_verified', Value: 'true' }] }));
    await markResource(state.evidence, intent, 'created'); await bindResourceIdentities(state.evidence, intent, [{ type: 'aws_cognito_user', identity: username, parent: pool }]);
    await state.cognito.send(new AdminSetUserPasswordCommand({ UserPoolId: pool, Username: username, Password: password, Permanent: true }));
    const read = await state.cognito.send(new AdminGetUserCommand({ UserPoolId: pool, Username: username })); user.sub = read.UserAttributes?.find(a => a.Name === 'sub')?.Value ?? ''; if (!user.sub || read.UserStatus !== 'CONFIRMED') throw new Error('AUTH_FIXTURE_FAILED'); users.set(key, user); return user;
  }
  async function control(kind: 'primary' | 'sibling' | 'foreign'): Promise<{ pool: string; client: string }> {
    const cached = clients.get(kind); if (cached) return cached;
    let pool = primaryPool; const main = (await state.cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: primaryPool, ClientId: primaryClient }))).UserPoolClient; if (!main) throw new Error('AUTH_FIXTURE_FAILED');
    if (kind === 'foreign') {
      const name = `${fixture.prefix}-foreign-pool-${serial}`; const intent = `${state.evidence.runId}/sdk-control/${name}`; await reserveResource(state.evidence, { kind: 'sdk-control', name, id: intent, suite: state.suite });
      const tracked: Control = { kind: 'pool', id: '', pool: '', intent, name }; auth.controls.push(tracked);
      try { const created = await state.cognito.send(new CreateUserPoolCommand({ PoolName: name, UserPoolTier: 'ESSENTIALS', DeletionProtection: 'ACTIVE', AdminCreateUserConfig: { AllowAdminCreateUserOnly: true }, AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'admin_only', Priority: 1 }] }, Schema: [{ Name: 'email', AttributeDataType: 'String', Mutable: true, Required: true, StringAttributeConstraints: { MinLength: '0', MaxLength: '2048' } }] })); tracked.id = created.UserPool?.Id ?? ''; tracked.pool = tracked.id; await bindControl(fixture, tracked); }
      catch (error) { if (!tracked.id) await recoverControl(fixture, tracked); throw error; } pool = tracked.id;
      const read = (await state.cognito.send(new DescribeUserPoolCommand({ UserPoolId: pool }))).UserPool; assertForeignPoolSettings(read, name);
      await state.cognito.send(new CreateResourceServerCommand({ UserPoolId: pool, Identifier: 'reminder-api', Name: 'Reminder API', Scopes: [{ ScopeName: 'read', ScopeDescription: "Read the signed-in owner's reminders and images" }, { ScopeName: 'write', ScopeDescription: "Write the signed-in owner's reminders and images" }] }));
    }
    const name = `${fixture.prefix}-${kind}-client-${serial}`; const intent = `${state.evidence.runId}/sdk-control/${name}`; await reserveResource(state.evidence, { kind: 'sdk-control', name, id: intent, suite: state.suite });
    const tracked: Control = { kind: 'client', id: '', pool, intent, name }; auth.controls.push(tracked);
    try { const created = await state.cognito.send(new CreateUserPoolClientCommand({ UserPoolId: pool, ClientName: name, ...clientInput(main) })); tracked.id = created.UserPoolClient?.ClientId ?? ''; await bindControl(fixture, tracked); }
    catch (error) { if (!tracked.id) await recoverControl(fixture, tracked); throw error; } const client = tracked.id;
    const read = (await state.cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: pool, ClientId: client }))).UserPoolClient; assertControlClientSettings(read, main, { pool, client }); const result = { pool, client }; clients.set(kind, result); return result;
  }
  const result: FixtureAuth = { async login(owner, scopes, kind) {
    const selected = await control(kind); const user = await createUser(selected.pool, owner); const verifier = randomBytes(48).toString('base64url'); const challenge = createHash('sha256').update(verifier).digest('base64url'); const nonce = randomBytes(24).toString('base64url'); const callback = 'https://extension.example.test/callback';
    // Discovery is read for the exact selected owned pool; no foreign host auto-allow.
    const discovery = await localRequest(fixture.target, new URL(`/${selected.pool}/.well-known/openid-configuration`, fixture.target.endpoint), {}); const doc = JSON.parse(discovery.bytes.toString()) as Record<string, string>; const identity = discoveredCognitoIdentity(fixture.target, selected.pool, doc); const authTarget = identity.target;
    const authorize = new URL(doc.authorization_endpoint!); for (const [key, value] of Object.entries({ client_id: selected.client, response_type: 'code', redirect_uri: callback, scope: scopes.join(' '), state: nonce, code_challenge: challenge, code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
    let page = await localRequest(authTarget, authorize, {}); let login = authorize; if (page.status === 302) { login = new URL(page.headers.get('location')!, authorize); page = await localRequest(authTarget, login, {}); }
    if (page.status !== 200) throw new Error('HOSTED_UI_FAILED'); const html = page.bytes.toString(); const csrf = /name=["']_csrf["'][^>]*value=["']([^"']+)/.exec(html)?.[1]; const cookie = page.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const form = new URLSearchParams({ username: user.username, password: user.password, ...(csrf ? { _csrf: csrf } : {}) });
    const signed = await localRequest(authTarget, login, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: form.toString() }); const location = signed.headers.get('location'); if (signed.status !== 302 || !location) throw new Error('HOSTED_UI_FAILED'); const returned = new URL(location); if (returned.origin + returned.pathname !== callback || returned.searchParams.get('state') !== nonce || !returned.searchParams.get('code')) throw new Error('HOSTED_UI_FAILED');
    const token = await localRequest(authTarget, new URL(doc.token_endpoint!), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: selected.client, redirect_uri: callback, code: returned.searchParams.get('code')!, code_verifier: verifier }).toString() }); if (token.status !== 200) throw new Error('TOKEN_EXCHANGE_FAILED'); return session(token.bytes);
  }, async refresh(current) { const token = await localRequest(fixture.target, new URL(state.stack.bindings.cognito_auth_base_url!.replace(/\/$/, '') + '/oauth2/token'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: current.claims.client_id, refresh_token: current.refreshToken }).toString() }); if (token.status !== 200) throw new Error('TOKEN_EXCHANGE_FAILED'); return session(token.bytes); } };
  await createUser(primaryPool, 'a'); await createUser(primaryPool, 'b'); auth.cases.set(caseId, result); return result;
}
function session(bytes: Buffer): AuthSession { const raw = JSON.parse(bytes.toString()) as { access_token: string; id_token?: string; refresh_token: string }; if (!raw.access_token || !raw.refresh_token) throw new Error('TOKEN_EXCHANGE_FAILED'); const claims = JSON.parse(Buffer.from(raw.access_token.split('.')[1] ?? '', 'base64url').toString()) as AuthSession['claims']; return { accessToken: raw.access_token, refreshToken: raw.refresh_token, claims, ...(raw.id_token ? { idToken: raw.id_token } : {}) }; }
/** Counts only independent latest SDK reads for the supplied authoritative manifest intents. */
export function sdkAbsenceCounts(fixture: SuiteFixture, intents: readonly string[]): { absent: number; exists: number; unverified: number } {
  const verified = authState(fixture).verified; return { absent: intents.filter(id => verified.get(id) === 'absent').length, exists: intents.filter(id => verified.get(id) === 'exists').length, unverified: intents.filter(id => !verified.has(id) || verified.get(id) === 'unverified').length };
}
export async function resetAuthControls(fixture: SuiteFixture): Promise<void> {
  const state = fixtureState(fixture); const auth = authState(fixture); let errors = 0;
  const absent = (error: unknown, codes: string[]) => codes.includes((error as { name?: string }).name ?? '');
  for (const user of auth.users.slice()) {
    auth.verified.set(user.intent, 'unverified');
    try {
      if (!user.username.startsWith(`${fixture.prefix}-`)) throw new Error('AUTH_CLEANUP_FAILED');
      try { await state.cognito.send(new AdminDeleteUserCommand({ UserPoolId: user.pool, Username: user.username })); } catch { /* independent read below decides actual absence */ }
      try { await state.cognito.send(new AdminGetUserCommand({ UserPoolId: user.pool, Username: user.username })); auth.verified.set(user.intent, 'exists'); throw new Error('AUTH_CLEANUP_FAILED'); } catch (error) { if (!absent(error, ['UserNotFoundException'])) throw error; }
      auth.verified.set(user.intent, 'absent');
      if (!evidenceContext(state.evidence).manifest.resources.find(r => r.id === user.intent)?.removed) await markResource(state.evidence, user.intent, 'removed');
      auth.users = auth.users.filter(u => u !== user);
    } catch { errors++; }
  }
  for (const control of auth.controls.slice().reverse()) {
    auth.verified.set(control.intent, 'unverified');
    try {
      if (!control.id || !control.name.startsWith(`${fixture.prefix}-`) || !evidenceContext(state.evidence).manifest.resources.find(r => r.id === control.intent)?.identities?.some(i => i.identity === control.id)) throw new Error('AUTH_CLEANUP_FAILED');
      try {
        if (control.kind === 'client') await state.cognito.send(new DeleteUserPoolClientCommand({ UserPoolId: control.pool, ClientId: control.id }));
        else { await state.cognito.send(new UpdateUserPoolCommand({ UserPoolId: control.pool, DeletionProtection: 'INACTIVE' })); await state.cognito.send(new DeleteUserPoolCommand({ UserPoolId: control.pool })); }
      } catch { /* continue exact-ID verification despite a failed delete */ }
      try {
        if (control.kind === 'client') await state.cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: control.pool, ClientId: control.id }));
        else await state.cognito.send(new DescribeUserPoolCommand({ UserPoolId: control.pool }));
        auth.verified.set(control.intent, 'exists'); throw new Error('AUTH_CLEANUP_FAILED');
      } catch (error) { if (!absent(error, ['ResourceNotFoundException'])) throw error; }
      auth.verified.set(control.intent, 'absent'); await markResource(state.evidence, control.intent, 'removed'); auth.controls = auth.controls.filter(c => c !== control);
    } catch { errors++; }
  }
  if (errors) throw new Error('AUTH_CLEANUP_FAILED'); auth.cases.clear();
}

export function assertForeignPoolSettings(pool: UserPoolType | undefined, name: string): void {
  const email = pool?.SchemaAttributes?.find(attribute => attribute.Name === 'email');
  try { assert.deepEqual([pool?.Name, pool?.DeletionProtection, pool?.UserPoolTier, pool?.AdminCreateUserConfig?.AllowAdminCreateUserOnly, pool?.AccountRecoverySetting?.RecoveryMechanisms, email?.AttributeDataType, email?.Mutable, email?.Required, email?.StringAttributeConstraints], [name, 'ACTIVE', 'ESSENTIALS', true, [{ Name: 'admin_only', Priority: 1 }], 'String', true, true, { MinLength: '0', MaxLength: '2048' }]); } catch { throw new Error('AUTH_FIXTURE_FAILED'); }
}
export function assertControlClientSettings(client: UserPoolClientType | undefined, main: UserPoolClientType, identity: { pool: string; client: string }): void {
  if (!client || client.ClientSecret !== undefined || client.ClientId !== identity.client || client.UserPoolId !== identity.pool) throw new Error('AUTH_FIXTURE_FAILED');
  try { assert.deepEqual(clientInput(client), clientInput(main)); } catch { throw new Error('AUTH_FIXTURE_FAILED'); }
}

/** Final read-only proof uses current retained manifest identities; never recover an unknown ID. */
export async function verifyOwnedSdkAbsence(fixture: SuiteFixture, intents: readonly string[]): Promise<{ checked: number; absent: number; exists: number; unverified: number }> {
  const state = fixtureState(fixture); const context = evidenceContext(state.evidence); if (!context.finalized || !state.disposed) throw new Error('CLEANUP_REJECTED');
  const result = { checked: intents.length, absent: 0, exists: 0, unverified: 0 };
  for (const intent of intents) {
    const resource = context.manifest.resources.find(item => item.id === intent); const identity = resource?.identities?.length === 1 ? resource.identities[0] : undefined;
    const parentOwned = !!identity?.parent && context.manifest.resources.some(item => item.identities?.some(binding => binding.type === 'aws_cognito_user_pool' && binding.identity === identity.parent));
    if (!resource || !resource.name.startsWith(`${fixture.prefix}-`) || !identity || (resource.kind === 'sdk-user' ? identity.type !== 'aws_cognito_user' || identity.identity !== resource.name || !parentOwned : resource.kind !== 'sdk-control' || !['aws_cognito_user_pool', 'aws_cognito_user_pool_client'].includes(identity.type) || (identity.type === 'aws_cognito_user_pool_client' && !parentOwned))) { result.unverified++; continue; }
    const send = <T>(command: T) => state.cognito.send(command as Parameters<typeof state.cognito.send>[0], { requestTimeout: 5000, abortSignal: AbortSignal.timeout(5000) });
    let status: 'absent' | 'exists' | 'unverified' = 'unverified';
    try {
      if (identity.type === 'aws_cognito_user') await send(new AdminGetUserCommand({ UserPoolId: identity.parent!, Username: identity.identity }));
      else if (identity.type === 'aws_cognito_user_pool_client') await send(new DescribeUserPoolClientCommand({ UserPoolId: identity.parent!, ClientId: identity.identity }));
      else await send(new DescribeUserPoolCommand({ UserPoolId: identity.identity }));
      status = 'exists';
    } catch (error) {
      const code = (error as { name?: string }).name;
      if (identity.type === 'aws_cognito_user' && code === 'ResourceNotFoundException') {
        try { await send(new DescribeUserPoolCommand({ UserPoolId: identity.parent! })); } catch (parentError) { if ((parentError as { name?: string }).name === 'ResourceNotFoundException') status = 'absent'; }
      } else if (identity.type === 'aws_cognito_user' ? code === 'UserNotFoundException' : code === 'ResourceNotFoundException') status = 'absent';
    }
    result[status]++; if (status === 'absent' && !resource.removed) await markResource(state.evidence, resource.id, 'removed');
  }
  return result;
}
