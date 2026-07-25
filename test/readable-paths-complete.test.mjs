import { test } from 'node:test';
import assert from 'node:assert';
import { createAgentTools } from '../src/agent-tools.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';

test('readable-paths-complete-regression', async () => {
  const root = join(tmpdir(), 'fcdev-test-' + Date.now());
  mkdirSync(join(root, 'public/nested'), { recursive: true });
  mkdirSync(join(root, 'private'), { recursive: true });
  writeFileSync(join(root, 'public/match.txt'), 'find-me');
  writeFileSync(join(root, 'private/secret.txt'), 'hidden');
  writeFileSync(join(root, 'public/a.txt'), 'a');
  writeFileSync(join(root, 'public/nested/b.txt'), 'b');

  const tools = createAgentTools({ 
    root, 
    verifyCommand: 'true', 
    readablePaths: ['public'] 
  });

  // omitted-root-traversal
  const res1 = JSON.parse(tools.execute({ action: 'list_files' }));
  assert.ok(res1.files.includes('public/match.txt'));
  assert.ok(!res1.files.includes('private/secret.txt'));

  // dot-root-traversal
  const res2 = JSON.parse(tools.execute({ action: 'list_files', args: { path: '.' } }));
  assert.ok(res2.files.includes('public/match.txt'));
  assert.ok(!res2.files.includes('private/secret.txt'));

  // directory-and-file-admission
  const res3 = JSON.parse(tools.execute({ action: 'list_files', args: { path: 'public' } }));
  assert.ok(res3.files.includes('public/a.txt'));
  assert.ok(res3.files.includes('public/nested/b.txt'));

  // explicit-private-base-refusal
  const res4 = JSON.parse(tools.execute({ action: 'list_files', args: { path: 'private' } }));
  assert.ok(res4.error.includes('outside declared readable paths'));

  // unrestricted-compatibility
  const toolsUnrestricted = createAgentTools({ root, verifyCommand: 'true' });
  const res5 = JSON.parse(toolsUnrestricted.execute({ action: 'list_files' }));
  assert.ok(res5.files.includes('private/secret.txt'));
  
  rmSync(root, { recursive: true, force: true });
});