import { createHash } from "node:crypto";
import { existsSync, readFileSync, opendirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { mkdirSync } from "node:fs";
import { applyEditBlocks, prepareCreateArtifact } from "@red-cup-engineering/software-edit-language-service";
import { runTestsCommand } from "@red-cup-engineering/sandbox-command-execution-service";
import { insideTerritory as inside } from "./territory-path.mjs";

const SKIP = new Set([".git", "node_modules", ".lake", "dist", "coverage"]);
// These are finite source/observation budgets, not a claim that an incomplete
// traversal or clipped model observation constitutes source receiving.
const MAX_WALK_FILES = 4096;
const MAX_WALK_DIRECTORIES = 4096;
const MAX_WALK_DIRECTORY_ENTRIES = 4096;
const MAX_WALK_DEPTH = 64;
const MAX_FILE_OBSERVATION_BYTES = 256 * 1024;
const MAX_READ_RESULT_BYTES = 64 * 1024;
const MAX_READ_LINES = 200;
const MAX_SEARCH_FILES = 256;
const MAX_SEARCH_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_LINE_CHARS = 2048;

function walk(root, at = root, { maxFiles = MAX_WALK_FILES, maxDirectories = MAX_WALK_DIRECTORIES } = {}) {
  const files = [];
  const pending = [{ path: at, depth: 0 }];
  let directories = 0;
  while (pending.length) {
    const { path: directory, depth } = pending.pop();
    if (++directories > maxDirectories || depth > MAX_WALK_DEPTH)
      return { files: files.sort(), truncated: true };
    if (!existsSync(directory)) continue;
    // Iterate one directory through a bounded native handle. readdirSync()
    // loads the *entire* directory before a file-count cap can act; a single
    // enormous fanout could otherwise exhaust process memory. A complete
    // directory is sorted deterministically. A partial directory remains
    // explicitly incomplete and may never qualify a source census.
    const entries = [];
    const handle = opendirSync(directory);
    let directoryTruncated = false;
    try {
      for (let entry; (entry = handle.readSync()) !== null;) {
        if (entries.length === MAX_WALK_DIRECTORY_ENTRIES) {
          directoryTruncated = true;
          break;
        }
        entries.push(entry);
      }
    } finally {
      handle.closeSync();
    }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    let unobserved = false;
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push({ path, depth: depth + 1 });
      else if (entry.isFile()) {
        if (files.length === maxFiles) return { files: files.sort(), truncated: true };
        files.push(relative(root, path));
      } else {
        // Symlinks, pipes, sockets and devices are not ordinary source
        // files. Never silently promote their omission into a complete
        // Work source census: an operator must explicitly resolve them.
        unobserved = true;
      }
    }
    if (directoryTruncated || unobserved) return { files: files.sort(), truncated: true };
  }
  return { files: files.sort(), truncated: false };
}

export function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function territorySnapshot(root) {
  return walk(root);
}

export function createAgentTools({ root, verifyCommand, acceptanceCommand = verifyCommand, commands = {}, writablePaths = [], readablePaths = [] } = {}) {
  const changed = new Map();
  const admittedWrites = writablePaths.map((path) => relative(root, inside(root, path)));
  const writeAdmitted = (path) => !admittedWrites.length || admittedWrites.some((allowed) => path === allowed || path.startsWith(`${allowed}${sep}`));
  const admittedReads = readablePaths.map((path) => relative(root, inside(root, path)));
  const readAdmitted = (path) => !admittedReads.length || admittedReads.some((allowed) => path === allowed || path.startsWith(`${allowed}${sep}`));
  const observe = (value) => JSON.stringify(value);
  const checkObservation = (result) => ({ passed: result.passed, output: result.passed ? "exit=0" : result.output });
  const checks = () => {
    const verification = runTestsCommand(root, verifyCommand);
    const acceptance = acceptanceCommand === verifyCommand ? verification : runTestsCommand(root, acceptanceCommand);
    return { verification, acceptance };
  };
  let settledChecks = verifyCommand
    ? checks()
    : { verification: { passed: false, output: "" }, acceptance: { passed: false, output: "" } };
  return {
    changed,
    restoreChanges(changes = []) {
      if (changed.size) throw new Error("checkpoint restoration requires a fresh process workspace");
      for (const change of changes) {
        const path = inside(root, change?.path), relativePath = relative(root, path);
        if (!writeAdmitted(relativePath)) throw new Error(`checkpoint path is outside declared writable paths: ${relativePath}`);
        const existed = existsSync(path), before = existed ? readFileSync(path) : Buffer.alloc(0);
        if (existed !== change?.beforeExisted || `sha256:${digest(before)}` !== change?.beforeDigest) {
          throw new Error(`checkpoint does not descend from the admitted source: ${relativePath}`);
        }
        const after = Buffer.from(change?.afterBytesBase64 ?? "", "base64");
        if (`sha256:${digest(after)}` !== change?.afterDigest) throw new Error(`checkpoint after digest is invalid: ${relativePath}`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, after);
        changed.set(relativePath, { existed, bytes: before, digest: digest(before) });
      }
      settledChecks = checks();
      return { changedPaths: [...changed.keys()], ...settledChecks };
    },
    execute(action) {
      const args = action?.args || {};
      if (action.action === "list_files") {
        const requested = Number(args.max);
        const selected = Number.isSafeInteger(requested) && requested >= 0
          ? Math.min(requested, MAX_WALK_FILES) : MAX_WALK_FILES;
        if (selected === 0)
          return observe({ files: [], truncated: true, truncationAuthority: "caller" });
        const base = inside(root, args.path || ".");
        const relativePath = relative(root, base);
        if (relativePath !== "" && !readAdmitted(relativePath))
          return observe({ error: "list_files path is outside declared readable paths: " + relativePath });
        if (existsSync(base) && !statSync(base).isDirectory())
          return observe({ error: "list_files requires a directory" });
        const discovered = walk(root, base);
        const admitted = discovered.files.filter(file => readAdmitted(file));
        const truncated = discovered.truncated || admitted.length > selected;
        return observe({ files: admitted.slice(0, selected), truncated,
          ...(truncated ? { truncationAuthority: discovered.truncated || selected === MAX_WALK_FILES
            ? "resource" : "caller" } : {}) });
      }
      if (action.action === "search") {
        if (typeof args.query !== "string" || !args.query || args.query.length > 512)
          return observe({ error: "search requires a nonempty query of at most 512 characters" });
        const requested = Number(args.max);
        const selected = Number.isSafeInteger(requested) && requested >= 0
          ? Math.min(requested, MAX_SEARCH_RESULTS) : MAX_SEARCH_RESULTS;
        if (selected === 0)
          return observe({ hits: [], truncated: true, truncationAuthority: "caller" });
        const base = inside(root, args.path || ".");
        const relativePath = relative(root, base);
        if (relativePath !== "" && !readAdmitted(relativePath))
          return observe({ error: "search path is outside declared readable paths: " + relativePath });
        if (existsSync(base) && !statSync(base).isDirectory())
          return observe({ error: "search requires a directory" });
        const discovered = walk(root, base, { maxFiles: MAX_SEARCH_FILES });
        const hits = [], query = args.query.toLowerCase();
        let inspectedBytes = 0, incomplete = discovered.truncated;
        for (const file of discovered.files) {
          if (!readAdmitted(file)) continue;
          const path = inside(root, file);
          let source;
          try {
            const size = statSync(path).size;
            if (size > MAX_FILE_OBSERVATION_BYTES) { incomplete = true; continue; }
            if (inspectedBytes + size > MAX_SEARCH_TOTAL_BYTES) { incomplete = true; break; }
            source = readFileSync(path, "utf8");
            inspectedBytes += size;
          } catch { incomplete = true; continue; }
          for (const [index, line] of source.split("\n").entries()) {
            if (!line.toLowerCase().includes(query)) continue;
            const lineTruncated = line.length > MAX_SEARCH_LINE_CHARS;
            if (lineTruncated) incomplete = true;
            hits.push({ path: file, line: index + 1,
              text: lineTruncated ? line.slice(0, MAX_SEARCH_LINE_CHARS) : line,
              ...(lineTruncated ? { lineTruncated: true } : {}) });
            if (hits.length === selected)
              return observe({ hits, truncated: true,
                truncationAuthority: incomplete || selected === MAX_SEARCH_RESULTS ? "resource" : "caller" });
          }
        }
        return observe({ hits, truncated: incomplete,
          ...(incomplete ? { truncationAuthority: "resource" } : {}) });
      }
      if (action.action === "read") {
        if (typeof args.path !== "string" || !args.path.trim())
          return observe({ ok: false, terminal: true, error: "read requires a nonempty source path" });
        const path = inside(root, args.path), relativePath = relative(root, path);
        if (!readAdmitted(relativePath))
          return observe({ ok: false, terminal: true, error: "read path is outside declared readable paths: " + relativePath });
        let size;
        try {
          const metadata = statSync(path);
          if (!metadata.isFile()) return observe({ ok: false, terminal: true, error: "read requires an ordinary file" });
          size = metadata.size;
        } catch (error) {
          if (error?.code === "ENOENT") return observe({ ok: false, terminal: true, error: "read source does not exist" });
          throw error;
        }
        if (size > MAX_FILE_OBSERVATION_BYTES)
          return observe({ ok: false, terminal: true, error: "read source exceeds the bounded 256 KiB file observation" });
        const start = args.startLine === undefined ? 1 : Number(args.startLine);
        if (!Number.isSafeInteger(start) || start < 1)
          return observe({ ok: false, terminal: true, error: "read startLine must be a positive safe integer" });
        const end = args.endLine === undefined ? undefined : Number(args.endLine);
        if (end !== undefined && (!Number.isSafeInteger(end) || end < start))
          return observe({ ok: false, terminal: true, error: "read endLine must be a safe integer not before startLine" });
        const lines = readFileSync(path, "utf8").split("\n");
        const requestedLast = Math.min(end === undefined ? lines.length : end, lines.length);
        const last = Math.min(requestedLast, start + MAX_READ_LINES - 1);
        const text = lines.slice(start - 1, last).join("\n");
        if (Buffer.byteLength(text, "utf8") > MAX_READ_RESULT_BYTES)
          return observe({ ok: false, terminal: true,
            error: "read result exceeds 64 KiB; select a narrower line range" });
        const truncated = last < requestedLast;
        return observe({ path: relativePath, startLine: start, endLine: last, text, truncated,
          ...(truncated ? { truncationAuthority: "resource" } : {}) });
      }
      if (action.action === "edit") {
        const path = inside(root, args.path), relativePath = relative(root, path);
        if (!writeAdmitted(relativePath)) return observe({ ok: false, error: `edit path is outside declared writable paths: ${relativePath}`, writablePaths: admittedWrites });
        const existed = existsSync(path);
        const before = existed ? readFileSync(path, "utf8") : "";
        const blocks = (() => {
          if (typeof args.blocks === "string") return args.blocks;
          if (Array.isArray(args.blocks)) return args.blocks.map((block) => {
            if (typeof block === "string") return block;
            if (block && typeof block.search === "string" && typeof block.replace === "string") return `<<<<<<< SEARCH\n${block.search}\n=======\n${block.replace}\n>>>>>>> REPLACE`;
            return "";
          }).filter(Boolean).join("\n");
          if (args.blocks && typeof args.blocks.search === "string" && typeof args.blocks.replace === "string") return `<<<<<<< SEARCH\n${args.blocks.search}\n=======\n${args.blocks.replace}\n>>>>>>> REPLACE`;
          return "";
        })();
        const result = applyEditBlocks(before, blocks);
        if (!result.ok) return observe({ ok: false, terminal: true, error: result.reason || "no edit blocks" });
        if (result.result === before) return observe({ ok: false, terminal: true, error: "edit produced no differential information" });
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, result.result);
        const { verification, acceptance } = checks();
        if (settledChecks.verification.passed && !verification.passed) {
          writeFileSync(path, before);
          return observe({
            ok: false,
            rolledBack: true,
            error: "edit regressed a settled passing verification",
            verification: checkObservation(verification),
            acceptance: checkObservation(acceptance),
          });
        }
        if (!changed.has(relativePath)) changed.set(relativePath, { existed, bytes: Buffer.from(before), digest: digest(before) });
        settledChecks = { verification, acceptance };
        return observe({ ok: true, editBlocks: result.count, verification: checkObservation(verification), acceptance: checkObservation(acceptance) });
      }
      if (action.action === "create") {
        // Both the requested and provider-returned paths must stay within the
        // same ordinary-file territory; an admitted writable lane is not a
        // capability to follow symlinks into another owner.
        if (typeof args.path !== "string" || !args.path.trim())
          return observe({ ok: false, terminal: true, error: "create requires a nonempty target path" });
        try { inside(root, args.path); }
        catch (error) {
          // Preserve the JSON action refusal for lexical traversal without
          // downgrading the incumbent symlink inspection rejection.
          if (error?.message === "path escapes the admitted territory")
            return observe({ ok: false, terminal: true, error: error.message });
          throw error;
        }
        const prepared = prepareCreateArtifact({ workspace: root, path: args.path, content: args.content, writablePaths });
        if (!prepared.ok) return observe({ ok: false, terminal: true, error: prepared.reason });
        const receivedPath = inside(root, prepared.path);
        const relativePath = relative(root, receivedPath);
        mkdirSync(dirname(receivedPath), { recursive: true });
        writeFileSync(receivedPath, prepared.content);
        const { verification, acceptance } = checks();
        if (settledChecks.verification.passed && !verification.passed) {
          unlinkSync(receivedPath);
          return observe({
            ok: false,
            rolledBack: true,
            error: "create regressed a settled passing verification",
            verification: checkObservation(verification),
            acceptance: checkObservation(acceptance),
          });
        }
        changed.set(relativePath, { existed: false, bytes: Buffer.alloc(0), digest: digest("") });
        settledChecks = { verification, acceptance };
        return observe({ ok: true, created: true, verification: checkObservation(verification), acceptance: checkObservation(acceptance) });
      }
      if (action.action === "command") {
        const named = commands[String(args.name || "")];
        if (!named?.command) return observe({ terminal: true, error: `command is not admitted: ${args.name || "(missing)"}`, available: Object.keys(commands) });
        const result = runTestsCommand(root, named.command);
        return observe({ command: args.name, passed: result.passed, output: result.output });
      }
      if (action.action === "test" || action.action === "finish") {
        const { verification, acceptance } = checks();
        return observe({ verification: checkObservation(verification), acceptance: checkObservation(acceptance), changedPaths: [...changed.keys()] });
      }
      return observe({ terminal: true, error: `unknown action ${action?.action}` });
    },
    verify() { return checks(); },
    changes() {
      return [...changed.entries()].map(([path, before]) => {
        const current = readFileSync(inside(root, path));
        return { path, before, after: current, afterDigest: digest(current), changedBytes: Math.abs(current.length - before.bytes.length) + current.length };
      });
    },
  };
}
