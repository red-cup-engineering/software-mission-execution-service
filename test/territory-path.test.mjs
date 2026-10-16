import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { insideTerritory } from "../src/territory-path.mjs";

function trial(t) {
  const parent = mkdtempSync(join(tmpdir(), "software-mission-territory-path-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const territory = join(parent, "territory"), outsider = join(parent, "outside");
  mkdirSync(join(territory, "public", "nested"), { recursive: true });
  mkdirSync(outsider);
  writeFileSync(join(territory, "public", "ok.txt"), "allowed\n");
  writeFileSync(join(outsider, "secret.txt"), "outside\n");
  return { territory, outsider };
}

test("normal admitted file and nonexistent creation leaf remain accessible", (t) => {
  const { territory } = trial(t);
  assert.equal(readFileSync(insideTerritory(territory, "public/ok.txt"), "utf8"), "allowed\n");
  assert.equal(insideTerritory(territory, "public/nested/new.txt"), join(territory, "public/nested/new.txt"));
  assert.equal(insideTerritory(territory, "."), territory);
});

test("lexical path traversal is still refused", (t) => {
  const { territory } = trial(t);
  assert.throws(() => insideTerritory(territory, "../outside/secret.txt"), /escapes the admitted territory/);
});

test("direct, directory, in-territory and dangling symlinks are all refused", (t) => {
  const { territory, outsider } = trial(t);
  symlinkSync(join(outsider, "secret.txt"), join(territory, "public", "alias.txt"));
  symlinkSync(outsider, join(territory, "public", "outside-link"));
  symlinkSync(join(territory, "public", "ok.txt"), join(territory, "public", "inside-link"));
  symlinkSync(join(outsider, "absent"), join(territory, "public", "dangling"));
  for (const requested of ["public/alias.txt", "public/outside-link/secret.txt", "public/outside-link/new-file.txt", "public/inside-link", "public/dangling"]) {
    assert.throws(() => insideTerritory(territory, requested), /symbolic link/, requested);
  }
  assert.equal(readFileSync(join(territory, "public", "alias.txt"), "utf8"), "outside\n", "before patch, ordinary file APIs follow this link");
});
