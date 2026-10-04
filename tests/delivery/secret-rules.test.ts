import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(__dirname, "../..");
function git(directory: string, args: string[]) {
  return spawnSync("git", args, { cwd: directory, encoding: "utf8" });
}
function temporaryRepo(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "secret-rules-"));
  try {
    assert.equal(git(directory, ["init", "-q"]).status, 0);
    run(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

// Losing an ignore rule must expose a synthetic private path; public templates stay reviewable.
void test("secret_samples_are_distinct_from_private_files", () => {
  temporaryRepo((directory) => {
    writeFileSync(join(directory, ".gitignore"), readFileSync(join(root, ".gitignore")));
    for (const path of [".env", ".env.actions", ".env.production", "nested/.env.local", "credentials", ".aws/credentials", "infra/application/production/private.tfplan", "infra/bootstrap/terraform.tfstate.backup", "infra/platform/production/private.tfvars.json", "infra/bootstrap/backend.hcl", "infra/platform/production/.terraform/provider", "private/config.json", "private/owner-map.json", "images/private.png", "backups/backup.json", "artifacts/.d07-deps-remnant/file", "scripts/build/__pycache__/package.pyc", "reminders.json"]) {
      assert.equal(git(directory, ["check-ignore", "--no-index", "-q", "--", path]).status, 0, path);
    }
    for (const path of [".env.example", "infra/bootstrap/backend.hcl.example", "infra/application/production/terraform.tfvars.example", "infra/platform/production/.terraform.lock.hcl", "tests/fixtures/synthetic/owner-map.json"]) {
      assert.equal(git(directory, ["check-ignore", "--no-index", "-q", "--", path]).status, 1, path);
    }
  });
});

// Commands are passed as strings: the hooks must never execute them or read canary contents.
for (const provider of ["claude", "codex"]) {
  void test(`guards_reject_fake_sensitive_reads_${provider}`, () => {
    for (const command of ["cat .env", "cat .env.actions", "cat './.env.actions'", 'cat "/tmp/fake secrets/.env.production"', "head reminders.json", "cat ~/.aws/credentials", "cat private/owner-map.json", "cat infra/bootstrap/backend.hcl", "terraform show private.tfplan", "printenv", "env", "env | sort", "set", "export -p", "node -e 'console.log(process.env)'", "python3 -c 'print(os.environ)'", "cat /proc/self/environ"]) {
      const result = spawnSync("bash", [join(root, `.${provider}/hooks/check-bash-command.sh`)], { input: JSON.stringify({ tool_input: { command } }), encoding: "utf8" });
      assert.equal(result.status, 0, `${provider}: ${command}: ${result.stderr}`);
      const output = JSON.parse(result.stdout || "{}") as { hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string } };
      assert.equal(output.hookSpecificOutput?.hookEventName, "PreToolUse", command);
      assert.equal(output.hookSpecificOutput.permissionDecision, "deny", command);
    }
  });
  void test(`guards_allow_public_commands_${provider}`, () => {
    for (const command of ["cat .env.example", "cat infra/bootstrap/backend.hcl.example", "cat infra/application/production/terraform.tfvars.example", "cat tests/fixtures/synthetic/owner-map.json", "cat src/images/s3-store.ts", "npm test", "git status --short", "AWS_REGION=us-east-1 npm run infra:check", "env FOO=synthetic npm test"]) {
      const result = spawnSync("bash", [join(root, `.${provider}/hooks/check-bash-command.sh`)], { input: JSON.stringify({ tool_input: { command } }), encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "", command);
    }
  });
}

void test("untracking_preserves_local_bytes", () => {
  temporaryRepo((directory) => {
    for (const name of [".env.actions", "reminders.json"]) writeFileSync(join(directory, name), Buffer.alloc(0));
    assert.equal(git(directory, ["add", "--", ".env.actions", "reminders.json"]).status, 0);
    const before = [".env.actions", "reminders.json"].map((name) => readFileSync(join(directory, name)));
    assert.equal(git(directory, ["rm", "--cached", "--", ".env.actions", "reminders.json"]).status, 0);
    assert.equal(git(directory, ["ls-files", "--", ".env.actions", "reminders.json"]).stdout, "");
    for (const [index, name] of [".env.actions", "reminders.json"].entries()) {
      assert.ok(existsSync(join(directory, name)));
      assert.deepEqual(readFileSync(join(directory, name)), before[index]);
    }
  });
});

void test("agents_link_resolves_to_claude", () => {
  assert.equal(readlinkSync(join(root, "AGENTS.md")), "CLAUDE.md");
  assert.ok(existsSync(join(root, "AGENTS.md")), "shared contributor instructions must resolve");
});

// Claude documents gitignore-style Read patterns. Exercise the configured rules
// against empty synthetic paths; this is rule matching, not a live Claude session.
void test("claude_read_rules_cover_private_paths_and_leave_examples_public", () => {
  const settings = JSON.parse(readFileSync(join(root, ".claude/settings.json"), "utf8")) as { permissions: { deny: string[] } };
  temporaryRepo((directory) => {
    const patterns = settings.permissions.deny.filter((rule) => rule.startsWith("Read(") && !rule.startsWith("Read(~") && !rule.startsWith("Read(//")).map((rule) => {
      const pattern = rule.slice(5, -1);
      // Unanchored deny patterns apply at any depth under cwd in Claude.
      return pattern.startsWith("/") || pattern.startsWith("!") ? pattern : `**/${pattern}`;
    });
    writeFileSync(join(directory, ".gitignore"), patterns.join("\n"));
    for (const path of [".env", ".env.actions", "nested/.env.production", "reminders.json", ".aws/credentials", "infra/bootstrap/private.tfplan", "infra/bootstrap/terraform.tfstate", "infra/bootstrap/backend.hcl", "private/owner-map.json", "images/private.png"]) {
      assert.equal(git(directory, ["check-ignore", "--no-index", "-q", "--", path]).status, 0, path);
    }
    for (const path of [".env.example", "infra/bootstrap/backend.hcl.example", "infra/bootstrap/terraform.tfvars.example", "tests/fixtures/synthetic/owner-map.json", "src/images/s3-store.ts"]) {
      assert.equal(git(directory, ["check-ignore", "--no-index", "-q", "--", path]).status, 1, path);
    }
  });
});
