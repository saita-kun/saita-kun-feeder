const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const REMOVAL = path.join(ROOT, '.github/ISSUE_TEMPLATE/adopter-removal.yml');
const CANONICAL_URL = 'https://github.com/saita-kun/saita-kun-feeder/issues/new?template=adopter-removal.yml';

function readForm(formPath = REMOVAL) {
  const result = spawnSync('python3', ['-I', '-B', path.join(__dirname, 'helpers/read-issue-form.py'), formPath], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function fixtureForm(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adopter-removal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'form.yml');
  fs.writeFileSync(filename, source);
  return filename;
}

test('form reader keeps Markdown examples separate from required fields', (t) => {
  const source = fs.readFileSync(REMOVAL, 'utf8').replace('      value: |\n', [
    '      value: |', '        - type: input', '          id: example-only',
    '          validations:', '            required: true', '',
  ].join('\n'));
  const form = readForm(fixtureForm(t, source));
  assert.match(form.body[0].attributes.value, /id: example-only/);
  assert.deepEqual(form.body.filter((item) => item.validations?.required).map((item) => item.id).sort(),
    ['display-name', 'requester-role']);
});

test('form reader rejects elements and properties outside their parent section', (t) => {
  for (const source of [
    'body:\n  - type: input\n    id: example\nlabels: []\n  - type: input\n    id: misplaced\n',
    'body:\n  - type: input\n    attributes:\n      label: Example\n    id: example\n      required: true\n',
  ]) {
    assert.throws(() => readForm(fixtureForm(t, source)), /Expected body before elements|Unexpected indentation/);
  }
});

test('removal form requires only display name and requester role', () => {
  const form = readForm();
  assert.equal(form.name, 'ADOPTERS 削除依頼');
  assert.ok(typeof form.description === 'string' && form.description.trim());
  assert.ok(Array.isArray(form.body));
  const fields = form.body.filter((item) => item.type !== 'markdown');
  assert.ok(fields.every((item) => /^[a-z0-9_-]+$/.test(item.id || '')));
  assert.equal(new Set(fields.map((item) => item.id)).size, fields.length);
  assert.ok(fields.every((item) => typeof item.attributes?.label === 'string' && item.attributes.label.trim()));
  for (const item of form.body) {
    if (item.validations) assert.equal(typeof item.validations.required, 'boolean');
  }
  assert.deepEqual(form.body.filter((item) => item.validations?.required).map((item) => item.id).sort(),
    ['display-name', 'requester-role']);
  assert.equal(fields.find((item) => item.id === 'display-name').type, 'input');
});

test('removal form offers requester roles without publication consent', () => {
  const form = readForm();
  const role = form.body.find((item) => item.id === 'requester-role');
  assert.equal(role.type, 'dropdown');
  assert.deepEqual(role.attributes.options, ['本人', '掲載の権限を持つ担当者']);
  assert.equal(role.attributes.multiple ?? false, false);
  assert.ok(form.body.every((item) => item.type !== 'checkboxes'));
  assert.doesNotMatch(fs.readFileSync(REMOVAL, 'utf8'), /掲載されることに同意|収載を許諾/);
});

test('removal form keeps the original issue URL and additional information optional', () => {
  const form = readForm();
  for (const [id, type] of [['original-issue-url', 'input'], ['additional-info', 'textarea']]) {
    const field = form.body.find((item) => item.id === id);
    assert.equal(field?.type, type);
    assert.equal(field.validations?.required ?? false, false);
  }
});

test('removal instructions share the canonical form URL', () => {
  const notices = readForm().body.filter((item) => item.type === 'markdown').map((item) => item.attributes.value).join('\n');
  assert.match(notices, /canonical repo（saita-kun\/saita-kun-feeder）でのみ受け付けます/);
  assert.ok(notices.includes(`<${CANONICAL_URL}>`));
  const adopters = fs.readFileSync(path.join(ROOT, 'ADOPTERS.md'), 'utf8');
  assert.ok(adopters.split('\n').some((line) => line.includes('削除依頼') && line.includes('canonical repo')
    && line.includes(`(${CANONICAL_URL})`)));
  assert.ok(adopters.includes('(https://github.com/saita-kun/saita-kun-feeder/issues/new?template=adopter-entry.yml)'));
});

test('entry form preserves its agreed Git blob hash', () => {
  const entry = fs.readFileSync(path.join(ROOT, '.github/ISSUE_TEMPLATE/adopter-entry.yml'));
  const hash = crypto.createHash('sha1').update(`blob ${entry.length}\0`).update(entry).digest('hex');
  assert.equal(hash, 'bb78e3bfcdee22fffc9ff541bdc06158da90224a');
});
