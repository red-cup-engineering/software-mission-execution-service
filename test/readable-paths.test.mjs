import test from "node:test";
import assert from "node:assert";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createAgentTools } from "../src/agent-tools.mjs";

test("readablePaths restricts access to outside paths", () => {
  const root = resolve(tmpdir(), "test-territory-" + Date.now());
  mkdirSync(root, { recursive: true });
  const secret = join(root, "secret.txt");
  writeFileSync(secret, "confidential");

  const tools = createAgentTools({
    root,
    readablePaths: ["public"]
  });

  const result = tools.execute({
    action: "read",
    args: { path: "secret.txt" }
  });

  const response = JSON.parse(result);
  assert.equal(response.ok, false);
  assert.match(response.error, /outside declared readable paths/);

  rmSync(root, { recursive: true, force: true });
});

test("readablePaths allows access to within paths", () => {
  const root = resolve(tmpdir(), "test-territory-" + Date.now());
  mkdirSync(join(root, "public"), { recursive: true });
  const doc = join(root, "public", "doc.txt");
  writeFileSync(doc, "hello");

  const tools = createAgentTools({
    root,
    readablePaths: ["public"]
  });

  const result = tools.execute({
    action: "read",
    args: { path: "public/doc.txt" }
  });

  const response = JSON.parse(result);
  assert.equal(response.path, "public/doc.txt");
  assert.equal(response.text, "hello");
  assert.doesNotMatch(response.text, /^1: /);

  rmSync(root, { recursive: true, force: true });
});
