import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createAgentTools } from "../src/agent-tools.mjs";

test("structured provider edit arrays compile into deterministic SEARCH/REPLACE operations", () => {
  const root = mkdtempSync(join(tmpdir(), "union-edit-dialect-"));
  writeFileSync(join(root, "value.mjs"), "export const value = 1;\n");
  const tools = createAgentTools({ root, verifyCommand: "node --check value.mjs" });
  const result = JSON.parse(tools.execute({ action: "edit", args: { path: "value.mjs", blocks: [{ search: "export const value = 1;", replace: "export const value = 2;" }] } }));
  assert.equal(result.ok, true);
  assert.equal(result.verification.passed, true);
  assert.match(readFileSync(join(root, "value.mjs"), "utf8"), /value = 2/);
});

test("declared writable paths mechanically refuse an out-of-scope model edit", () => {
  const root = mkdtempSync(join(tmpdir(), "union-write-scope-"));
  writeFileSync(join(root, "admitted.mjs"), "export const admitted = 1;\n");
  writeFileSync(join(root, "protected.mjs"), "export const protectedValue = 1;\n");
  const tools = createAgentTools({ root, verifyCommand: "true", writablePaths: ["admitted.mjs"] });
  const result = JSON.parse(tools.execute({ action: "edit", args: { path: "protected.mjs", blocks: [{ search: "1", replace: "2" }] } }));
  assert.equal(result.ok, false);
  assert.match(result.error, /outside declared writable paths/);
  assert.match(readFileSync(join(root, "protected.mjs"), "utf8"), / = 1/);
});

test("an edit that carries no differential information is refused without recording a change", () => {
  const root = mkdtempSync(join(tmpdir(), "union-no-op-edit-"));
  const source = "export const value = 1;\n";
  writeFileSync(join(root, "value.mjs"), source);
  const tools = createAgentTools({ root, verifyCommand: "node --check value.mjs" });
  const result = JSON.parse(tools.execute({ action: "edit", args: { path: "value.mjs", blocks: [{ search: source, replace: source }] } }));
  assert.equal(result.ok, false);
  assert.match(result.error, /no differential information/);
  assert.equal(tools.changed.size, 0);
  assert.equal(readFileSync(join(root, "value.mjs"), "utf8"), source);
});

test("create delegates the absent exact writable target to the edit-language provider", () => {
  const root = mkdtempSync(join(tmpdir(), "union-create-dialect-"));
  const tools = createAgentTools({ root, verifyCommand: "node --check test/new.mjs", writablePaths: ["test/new.mjs"] });
  const created = JSON.parse(tools.execute({ action: "create", args: { path: "test/new.mjs", content: "export const created = true;\n" } }));
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(readFileSync(join(root, "test/new.mjs"), "utf8"), "export const created = true;\n");
  assert.equal(tools.changes()[0].before.existed, false);
  const duplicate = JSON.parse(tools.execute({ action: "create", args: { path: "test/new.mjs", content: "export const duplicate = true;\n" } }));
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /target absent/);
  const escaped = JSON.parse(tools.execute({ action: "create", args: { path: "../escape.mjs", content: "x" } }));
  assert.equal(escaped.ok, false);
});
