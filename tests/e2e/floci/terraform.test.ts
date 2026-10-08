import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runChild } from '../../../scripts/e2e/run.ts';
import { withTerraformTransport } from '../../../scripts/e2e/terraform-transport.ts';

void test('Terraform 1.16.5 rejects validation and postcondition override, scalar preserves original postcondition', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tf-override-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = (args: string[]) => runChild('terraform', args, { cwd: directory, timeoutMs: 30_000 });
  assert.equal((await runChild('terraform', ['version', '-json'], { cwd: directory, timeoutMs: 30_000 })).status, 'succeeded');
  const main = 'terraform { required_version = "= 1.16.5" }\nvariable "value" {\n type = string\n default = "valid"\n validation {\n condition = var.value == "valid"\n error_message = "Reject invalid synthetic input."\n }\n}\nresource "terraform_data" "guard" {\n input = var.value\n lifecycle {\n prevent_destroy = true\n postcondition {\n condition = self.output == "valid"\n error_message = "Preserved postcondition."\n }\n }\n}\n';
  await writeFile(join(directory, 'main.tf'), main);
  await writeFile(join(directory, 'override.tf.json'), JSON.stringify({ variable: { value: { validation: { condition: '${var.value == "other"}', error_message: 'New validation rejected.' } } } }));
  assert.equal((await run(['init', '-backend=false', '-input=false', '-no-color'])).status, 'failed');
  await writeFile(join(directory, 'override.tf.json'), JSON.stringify({ resource: { terraform_data: { guard: { lifecycle: { postcondition: { condition: '${self.output == "other"}', error_message: 'New postcondition rejected.' } } } } } }));
  assert.equal((await run(['init', '-backend=false', '-input=false', '-no-color'])).status, 'failed');
  await writeFile(join(directory, 'override.tf.json'), JSON.stringify({ resource: { terraform_data: { guard: { lifecycle: { prevent_destroy: false } } } } }));
  assert.equal((await run(['init', '-backend=false', '-input=false', '-no-color'])).status, 'succeeded');
  assert.equal((await run(['apply', '-auto-approve', '-input=false', '-no-color'])).status, 'succeeded');
  // A changed input that still passes the original variable validation must fail
  // the retained resource postcondition after scalar-only lifecycle merging.
  await writeFile(join(directory, 'main.tf'), main.replace('input = var.value', 'input = "invalid"'));
  assert.equal((await run(['apply', '-auto-approve', '-input=false', '-no-color'])).status, 'failed');
  assert.equal((await run(['destroy', '-auto-approve', '-input=false', '-no-color'])).status, 'succeeded');
});

void test('fixed AWS provider default STS endpoint is blocked before any upstream request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tf-default-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'main.tf.json'), JSON.stringify({ terraform: { required_version: '= 1.16.5', required_providers: { aws: { source: 'hashicorp/aws', version: '= 6.67.0' } } }, provider: { aws: { region: 'ap-northeast-1', access_key: 'local', secret_key: 'local', skip_credentials_validation: true, skip_metadata_api_check: true, skip_requesting_account_id: true, max_retries: 0, shared_config_files: [], shared_credentials_files: [], endpoints: { sts: 'https://sts.amazonaws.com' } } }, data: { aws_caller_identity: { negative: {} } } }));
  const providerDirectory = join(process.cwd(), '.superpowers/tools/aws-sdd/provider-probe/.terraform/providers');
  assert.equal((await runChild('terraform', ['init', '-backend=false', '-input=false', '-no-color', `-plugin-dir=${providerDirectory}`], { cwd: directory, timeoutMs: 30_000 })).status, 'succeeded');
  const result = await withTerraformTransport({ endpoint: 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map([['floci', '172.18.0.2']]) }, proxy => runChild('terraform', ['plan', '-input=false', '-no-color'], { cwd: directory, timeoutMs: 10_000, terraformProxy: proxy }));
  // The datasource retries its read despite max_retries=0. The process deadline
  // terminates it; every CONNECT is denied by our boundary before DNS/upstream.
  assert.equal(result.value.status, 'timeout'); assert.equal(result.forwarded, 0);
  assert.ok(result.denied.length > 0); assert.ok(result.denied.every(kind => kind === 'aws-sts'));
});
