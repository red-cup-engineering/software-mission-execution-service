import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("an admitted mission Work command carries source CPU-time proxy and bounded failure reason to its original receiver", (t) => {
  const root=mkdtempSync(join(tmpdir(),"union-mission-receiving-deadline-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,"slow.mjs"),"setTimeout(()=>{},30000);\\n");
  const tools=createAgentTools({
    root,verifyCommand:"node --check slow.mjs",
    commandLimits:{timeoutMs:60,maxOutputBytes:1024},
    commands:{hanging:{command:"node slow.mjs"}},
  });
  const received=JSON.parse(tools.execute({action:"command",args:{name:"hanging"}}));
  assert.equal(received.command,"hanging");
  assert.equal(received.passed,false);
  assert.equal(received.failureKind,"deadline");
  assert.ok(Number.isSafeInteger(received.observedWallMs)&&received.observedWallMs>=0);
  assert.equal(received.limits.timeoutMs,60);
  assert.equal(received.limits.maxOutputBytes,1024);
  assert.match(received.output,/ETIMEDOUT/u);
  // This is measured host wall time, NOT billed CPU seconds or accepted Work.
});

test("verification evidence does not erase output exhaustion or mislabel a failed job as accepted", (t) => {
  const root=mkdtempSync(join(tmpdir(),"union-mission-receiving-output-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,"noisy.mjs"),
    'process.stdout.write("Q".repeat(100000));\\n');
  const tools=createAgentTools({
    root,verifyCommand:"node --check noisy.mjs",
    commandLimits:{timeoutMs:10000,maxOutputBytes:1024},
    commands:{noisy:{command:"node noisy.mjs"}},
  });
  const readout=JSON.parse(tools.execute({action:"command",args:{name:"noisy"}}));
  assert.equal(readout.passed,false);
  assert.equal(readout.failureKind,"output-limit");
  assert.equal(readout.limits.maxOutputBytes,1024);
  assert.match(readout.output,/ENOBUFS/u);
  assert.ok(readout.output.length < 1600);
  const verified=JSON.parse(tools.execute({action:"test",args:{}}));
  assert.equal(verified.verification.passed,true);
  assert.equal(verified.verification.failureKind,null);
  assert.ok(Number.isSafeInteger(verified.verification.observedWallMs));
  assert.equal(verified.verification.limits.maxOutputBytes,1024);
});
