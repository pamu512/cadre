// The judge note used to be assigned before it was declared, so the write
// never happened and the catch swallowed the ReferenceError. This drives
// that path with a fake ax and a loopback judge.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const server = createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'Lane A wins. The evidence is on disk.' } }] }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const axDir = mkdtempSync(join(tmpdir(), 'cadre-ax-'));
const ax = join(axDir, 'ax');
writeFileSync(ax, `#!/bin/sh
if [ "$1" = lanes ]; then
  printf '  glm  ok\\n  grok ok\\n'
  exit 0
fi
printf 'EVIDENCE: stub from %s\\n' "$1"
`);
chmodSync(ax, 0o755);

const home = mkdtempSync(join(tmpdir(), 'cadre-debate-'));
process.env.CADRE_HOME = home;
process.env.CADRE_AX = ax;

mock.module(pathToFileURL(join(ROOT, 'src/scan.js')).href, {
  namedExports: {
    buildRoster: async () => ({
      lanes: [{
        name: 'judge-local',
        invoke: { kind: 'openai-compatible', base_url: `http://127.0.0.1:${port}/v1`, model: 'stub' },
      }],
    }),
  },
});

const { cmdDebate } = await import(pathToFileURL(join(ROOT, 'src/commands/debate.js')).href);

test('debate writes the judge note when the judge answers', async () => {
  try {
    const rc = await cmdDebate(['should we ship']);
    assert.equal(rc, 0);
    const debates = readdirSync(join(home, 'debates'));
    assert.equal(debates.length, 1);
    const files = readdirSync(join(home, 'debates', debates[0]));
    const judge = files.find((f) => f.startsWith('judge-'));
    assert.ok(judge, 'judge markdown must be filed, got: ' + files.join(', '));
    assert.match(readFileSync(join(home, 'debates', debates[0], judge), 'utf8'), /Lane A wins/);
  } finally {
    server.close();
  }
});
