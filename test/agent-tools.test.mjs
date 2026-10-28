import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createAgentTools, territorySnapshot } from "../src/agent-tools.mjs";

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
  assert.equal(escaped.terminal, true);
  assert.match(escaped.error, /path escapes the admitted territory/u);
  for (const path of [null, undefined, "", {}, join(tmpdir(), "other-owner-test.mjs")]) {
    const refused = JSON.parse(tools.execute({ action: "create", args: { path, content: "x" } }));
    assert.equal(refused.ok, false);
    assert.equal(refused.terminal, true);
  }
  assert.equal(tools.changed.size, 1,
    "refused create attempts cannot change source Work history");
});

test("fabrication tools refuse symlinked reads, edits, creations, and checkpoint restores", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "union-admitted-symlink-boundary-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "territory"), outside = join(parent, "other-owner");
  mkdirSync(join(root, "public"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.mjs"), "export const protectedValue = 1;\n");
  symlinkSync(join(outside, "secret.mjs"), join(root, "public", "leak.mjs"));
  symlinkSync(outside, join(root, "public", "through"));
  const tools = createAgentTools({ root, verifyCommand: "true", readablePaths: ["public"], writablePaths: ["public"] });
  assert.throws(() => tools.execute({ action: "read", args: { path: "public/leak.mjs" } }), /symbolic link/u);
  assert.throws(() => tools.execute({ action: "edit", args: { path: "public/leak.mjs",
    blocks: { search: "protectedValue = 1", replace: "protectedValue = 2" } } }), /symbolic link/u);
  assert.throws(() => tools.execute({ action: "create", args: { path: "public/through/new.mjs",
    content: "export const escaped = true;\n" } }), /symbolic link/u);
  assert.throws(() => tools.restoreChanges([{ path: "public/leak.mjs" }]), /symbolic link/u);
  assert.equal(readFileSync(join(outside, "secret.mjs"), "utf8"), "export const protectedValue = 1;\n");
});


test("real original listing and search honor caller bounds without reporting a complete view", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-observation-list-search-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "a.mjs"), "export const needle = 1;\n");
  writeFileSync(join(root, "b.mjs"), "export const needle = 2;\n");
  writeFileSync(join(root, "c.mjs"), "export const needle = 3;\n");
  const tools = createAgentTools({ root });
  const emptyList = JSON.parse(tools.execute({ action: "list_files", args: { max: 0 } }));
  assert.deepEqual(emptyList, { files: [], truncated: true, truncationAuthority: "caller" });
  const partialList = JSON.parse(tools.execute({ action: "list_files", args: { max: 2 } }));
  assert.deepEqual(partialList, { files: ["a.mjs", "b.mjs"], truncated: true, truncationAuthority: "caller" });
  const completeList = JSON.parse(tools.execute({ action: "list_files", args: {} }));
  assert.deepEqual(completeList, { files: ["a.mjs", "b.mjs", "c.mjs"], truncated: false });

  const emptySearch = JSON.parse(tools.execute({ action: "search", args: { query: "needle", max: 0 } }));
  assert.deepEqual(emptySearch, { hits: [], truncated: true, truncationAuthority: "caller" });
  const partialSearch = JSON.parse(tools.execute({ action: "search", args: { query: "needle", max: 1 } }));
  assert.equal(partialSearch.hits.length, 1);
  assert.equal(partialSearch.truncated, true);
  assert.equal(partialSearch.truncationAuthority, "caller");
  const fullSearch = JSON.parse(tools.execute({ action: "search", args: { query: "needle" } }));
  assert.deepEqual(fullSearch.hits.map(hit => hit.path), ["a.mjs", "b.mjs", "c.mjs"]);
  assert.equal(fullSearch.truncated, false);
  assert.equal(tools.changed.size, 0);
});

test("real original read is bounded by admitted file bytes, selected lines and output bytes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-observation-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows = Array.from({ length: 243 }, (_, i) => "row " + (i + 1));
  writeFileSync(join(root, "source.txt"), rows.join("\n"));
  writeFileSync(join(root, "oversized.txt"), "x".repeat(256 * 1024 + 1));
  writeFileSync(join(root, "long-line.txt"), "l".repeat(70 * 1024));
  const tools = createAgentTools({ root, readablePaths: ["source.txt", "oversized.txt", "long-line.txt"] });
  const selected = JSON.parse(tools.execute({ action: "read", args: { path: "source.txt", startLine: 2, endLine: 3 } }));
  assert.equal(selected.text, "row 2\nrow 3");
  assert.equal(selected.truncated, false);
  const initial = JSON.parse(tools.execute({ action: "read", args: { path: "source.txt" } }));
  assert.equal(initial.startLine, 1);
  assert.equal(initial.endLine, 200);
  assert.equal(initial.text.split("\n").length, 200);
  assert.equal(initial.truncated, true);
  assert.equal(initial.truncationAuthority, "resource");
  const rest = JSON.parse(tools.execute({ action: "read", args: { path: "source.txt", startLine: 201 } }));
  assert.equal(rest.startLine, 201);
  assert.equal(rest.truncated, false);
  assert.equal(rest.text.split("\n").length, 43);

  for (const args of [{}, { path: null }, { path: "" }, { path: "missing.mjs" },
    { path: "source.txt", startLine: Infinity }, { path: "source.txt", startLine: 0 },
    { path: "source.txt", startLine: 10, endLine: 9 }]) {
    const refusal = JSON.parse(tools.execute({ action: "read", args }));
    assert.equal(refusal.ok, false, "invalid read must not interrupt the Work actor");
    assert.equal(refusal.terminal, true);
  }
  assert.match(JSON.parse(tools.execute({ action: "read", args: { path: "oversized.txt" } })).error, /256 KiB/);
  assert.match(JSON.parse(tools.execute({ action: "read", args: { path: "long-line.txt" } })).error, /64 KiB/);
  const search = JSON.parse(tools.execute({ action: "search", args: { query: "x" } }));
  assert.equal(search.truncated, true);
  assert.equal(search.truncationAuthority, "resource");
  assert.equal(search.hits.length, 0);
  assert.equal(tools.changed.size, 0);
});

test("source inventory and search report actual resource exhaustion instead of complete-looking evidence", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mission-observation-finite-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 4098; i++) writeFileSync(join(root, "file-" + String(i).padStart(5, "0") + ".txt"), "sample\n");
  const snapshot = territorySnapshot(root);
  assert.equal(snapshot.files.length, 4096);
  assert.equal(snapshot.truncated, true,
    "an incomplete source set must not masquerade as fully inventoried territory");
  assert.deepEqual(snapshot.files, [...snapshot.files].sort(),
    "source observation must be deterministic, independent of readdir order");
  const tools = createAgentTools({ root });
  const list = JSON.parse(tools.execute({ action: "list_files", args: {} }));
  assert.equal(list.files.length, 4096);
  assert.equal(list.truncated, true);
  assert.equal(list.truncationAuthority, "resource");
  const search = JSON.parse(tools.execute({ action: "search", args: { query: "not-in-source" } }));
  assert.equal(search.hits.length, 0);
  assert.equal(search.truncated, true);
  assert.equal(search.truncationAuthority, "resource");
  assert.equal(tools.changed.size, 0);
  // A directory precisely at the finite envelope remains complete.
  rmSync(join(root, "file-04096.txt"));
  rmSync(join(root, "file-04097.txt"));
  const exact = territorySnapshot(root);
  assert.equal(exact.files.length, 4096);
  assert.equal(exact.truncated, false,
    "the source census distinguishes a reached capacity from overflow");
});
