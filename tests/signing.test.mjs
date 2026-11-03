import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = name => readFileSync(path.join(root, name), 'utf8');
const IDENTITY = '0123456789ABCDEF0123456789ABCDEF01234567';

// Runs the import script against stand-ins for the macOS tools it drives.
function importCertificate({ identities = `  1) ${IDENTITY} "Wuwa Tappo Signing" (CSSMERR_TP_NOT_TRUSTED)\n     1 identities found\n`, importFails = false, trustFails = false, password = 'export-password' } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'wuwa-signing-'));
  const bin = path.join(directory, 'bin'), runner = path.join(directory, 'runner');
  spawnSync('mkdir', ['-p', bin, runner]);
  const log = path.join(directory, 'calls.log');
  const tool = (name, body) => { writeFileSync(path.join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
  tool('uname', 'echo Darwin');
  tool('openssl', 'echo generated-keychain-password');
  tool('sudo', `[ "$1 $2" = "security add-trusted-cert" ] && exit ${trustFails ? 1 : 0}; exit 0`);
  tool('security', `case "$1" in
  import) ls "$2" >> "${log}"; exit ${importFails ? 1 : 0} ;;
  list-keychains) [ "$3" = -s ] || printf '    "/Users/runner/Library/Keychains/login.keychain-db"\\n    "/Library/Keychains/System.keychain"\\n' ;;
  find-certificate) echo '-----BEGIN CERTIFICATE-----' ;;
  find-identity) printf '%s' '${identities}' ;;
esac`);
  const env = {
    PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runner, GITHUB_ENV: path.join(directory, 'github.env'),
    MACOS_SIGNING_CERTIFICATE: Buffer.from('pkcs12-bytes').toString('base64').replace(/(.{8})/g, '$1\n'),
    MACOS_SIGNING_CERTIFICATE_PASSWORD: password,
  };
  const result = spawnSync('bash', [path.join(root, 'scripts/import-signing-certificate.sh')], { encoding: 'utf8', env });
  const output = { ...result, calls: readFileSync(log, 'utf8'), env: (() => { try { return readFileSync(env.GITHUB_ENV, 'utf8'); } catch { return ''; } })(), leftovers: readdirSync(runner) };
  rmSync(directory, { recursive: true, force: true });
  return output;
}

test('the signing certificate is imported into a temporary keychain and exposed only by fingerprint', () => {
  const result = importCertificate();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.env, new RegExp(`^MACOS_SIGNING_IDENTITY=${IDENTITY}$`, 'm'));
  assert.match(result.env, /^MACOS_SIGNING_KEYCHAIN=.*wuwatappo-signing\.keychain-db$/m);
  assert.match(result.calls, /security import .*wuwatappo-signing\.p12 -k .*wuwatappo-signing\.keychain-db -f pkcs12 -P export-password -T \/usr\/bin\/codesign/);
  assert.match(result.calls, /security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k generated-keychain-password/);
  assert.match(result.calls, /security list-keychains -d user -s \S*wuwatappo-signing\.keychain-db \/Users\/runner\/Library\/Keychains\/login\.keychain-db \/Library\/Keychains\/System\.keychain/);
  assert.match(result.calls, /sudo security add-trusted-cert -d -r trustRoot -p codeSign/);
  assert.deepEqual(result.leftovers, [], 'the decoded certificate is removed after import');
  assert.doesNotMatch(result.stdout + result.stderr, /export-password|pkcs12-bytes|generated-keychain-password/);
});

test('signing setup explains missing identities and bad exports instead of building ad-hoc', () => {
  const noIdentity = importCertificate({ identities: '     0 identities found\n' });
  assert.equal(noIdentity.status, 1);
  assert.match(noIdentity.stdout, /no code signing identity/);
  assert.equal(noIdentity.env, '');
  const badExport = importCertificate({ importFails: true });
  assert.equal(badExport.status, 1);
  assert.match(badExport.stdout, /Could not import MACOS_SIGNING_CERTIFICATE/);
  assert.deepEqual(badExport.leftovers, []);
  const untrusted = importCertificate({ trustFails: true });
  assert.equal(untrusted.status, 0);
  assert.match(untrusted.stdout, /::warning::/);
});

test('only the import step receives the signing secrets, and forks fall back to ad-hoc signing', () => {
  const build = read('.github/workflows/build.yml');
  assert.match(build, /secrets:\n(?:\s+#.*\n)*\s+MACOS_SIGNING_CERTIFICATE:\n\s+required: false\n\s+MACOS_SIGNING_CERTIFICATE_PASSWORD:\n\s+required: false/);
  assert.match(build, /MACOS_SIGNING_CONFIGURED: \$\{\{ secrets\.MACOS_SIGNING_CERTIFICATE != '' && secrets\.MACOS_SIGNING_CERTIFICATE_PASSWORD != '' \}\}/);
  assert.equal((build.match(/: \$\{\{ secrets\.MACOS_SIGNING_CERTIFICATE(?:_PASSWORD)? \}\}/g) ?? []).length, 2);
  const step = build.slice(build.indexOf('- name: Import stable signing certificate'), build.indexOf('- name: Verify and package ZIP and DMG'));
  assert.match(step, /if: env\.MACOS_SIGNING_CONFIGURED == 'true'/);
  assert.match(step, /MACOS_SIGNING_CERTIFICATE: \$\{\{ secrets\.MACOS_SIGNING_CERTIFICATE \}\}/);
  assert.match(step, /run: bash scripts\/import-signing-certificate\.sh/);
  assert.ok(build.indexOf('Build complete application') < build.indexOf('Import stable signing certificate'));
  assert.match(build, /- name: Remove temporary signing keychain\n\s+if: always\(\) && env\.MACOS_SIGNING_KEYCHAIN != ''/);
  for (const name of ['ci.yml', 'release.yml']) {
    const workflow = read(`.github/workflows/${name}`);
    assert.doesNotMatch(workflow, /secrets: inherit|pull_request_target/);
    assert.match(workflow, /uses: \.\/\.github\/workflows\/build\.yml[\s\S]*secrets:\n\s+MACOS_SIGNING_CERTIFICATE: \$\{\{ secrets\.MACOS_SIGNING_CERTIFICATE \}\}\n\s+MACOS_SIGNING_CERTIFICATE_PASSWORD: \$\{\{ secrets\.MACOS_SIGNING_CERTIFICATE_PASSWORD \}\}/);
  }
});

test('packaging re-signs with the stable certificate before verifying, and requires a certificate-based requirement', () => {
  const script = read('scripts/package-macos.sh');
  const signing = script.indexOf('if [ -n "${MACOS_SIGNING_IDENTITY:-}" ]; then');
  assert.ok(signing > 0 && signing < script.indexOf('/usr/bin/codesign --verify --deep --strict "$APP"'));
  assert.match(script, /--force --deep --timestamp=none --preserve-metadata=entitlements --sign "\$MACOS_SIGNING_IDENTITY"/);
  assert.match(script, /\*"identifier \\"\$IDENTIFIER\\""\*certificate\*\)/);
});
