import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { mkdirSync } from "node:fs";
import { applyEditBlocks, prepareCreateArtifact } from "@emsenn/software-edit-language-service";
import { runTestsCommand } from "@emsenn/sandbox-command-execution-service";

const SKIP = new Set([".git", "node_modules", ".lake", "dist", "coverage"]);

function inside(root, requested = ".") {
  const path = resolve(root, requested);
  if (path !== resolve(root) && !path.startsWith(resolve(root) + sep)) throw new Error("path escapes the admitted territory");
  return path;
}

function walk(root, at = root, out = [], max = 600) {
  if (out.length >= max || !existsSync(at)) return out;
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    if (out.length >= max || SKIP.has(entry.name)) continue;
    const path = resolve(at, entry.name);
    if (entry.isDirectory()) walk(root, path, out, max);
    else if (entry.isFile()) out.push(relative(root, path));
  }
  return out;
}

export function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function territorySnapshot(root, { maxFiles = 600 } = {}) {
  const files = walk(root, root, [], maxFiles);
  return { files, truncated: files.length >= maxFiles };
}

export function createAgentTools({ root, verifyCommand, acceptanceCommand = verifyCommand, commands = {}, writablePaths = [], readablePaths = [], maxObservationBytes = 10000 } = {}) {
  const changed = new Map();
  const admittedWrites = writablePaths.map((path) => relative(root, inside(root, path)));
  const writeAdmitted = (path) => !admittedWrites.length || admittedWrites.some((allowed) => path === allowed || path.startsWith(`${allowed}${sep}`));
  const admittedReads = readablePaths.map((path) => relative(root, inside(root, path)));
  const readAdmitted = (path) => !admittedReads.length || admittedReads.some((allowed) => path === allowed || path.startsWith(`${allowed}${sep}`));
  const observe = (value) => JSON.stringify(value).slice(0, maxObservationBytes);
  const checkObservation = (result) => ({ passed: result.passed, output: result.passed ? "exit=0" : result.output.slice(-8000) });
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
    execute(action) {
      const args = action?.args || {};
      if (action.action === "list_files") {
        const relativePath = relative(root, resolve(root, args.path || "."));
        if (relativePath !== "" && !readAdmitted(relativePath)) return observe({ error: `list_files path is outside declared readable paths: ${relativePath}` });
        const base = inside(root, args.path || ".");
        return observe({ files: walk(root, base, [], Math.min(Number(args.max) || 250, 600)).filter(file => readAdmitted(file)) });
      }
      if (action.action === "search") {
        const query = String(args.query || "");
        if (!query) return observe({ error: "search requires args.query" });
        const relativePath = relative(root, resolve(root, args.path || "."));
        if (relativePath !== "" && !readAdmitted(relativePath)) return observe({ error: `search path is outside declared readable paths: ${relativePath}` });
        const base = inside(root, args.path || ".");
        const hits = [];
        for (const file of walk(root, base, [], 600)) {
          if (!readAdmitted(file)) continue;
          const path = inside(root, file);
          let text;
          try { text = readFileSync(path, "utf8"); } catch { continue; }
          for (const [index, line] of text.split("\n").entries()) {
            if (line.toLowerCase().includes(query.toLowerCase())) hits.push({ path: file, line: index + 1, text: line.slice(0, 500) });
            if (hits.length >= 80) return observe({ hits, truncated: true });
          }
        }
        return observe({ hits, truncated: false });
      }
      if (action.action === "read") {
        const path = inside(root, args.path);
        const relativePath = relative(root, path);
        if (!readAdmitted(relativePath)) return observe({ ok: false, error: `read path is outside declared readable paths: ${relativePath}` });
        const start = Math.max(1, Number(args.startLine) || 1), end = Math.min(start + 399, Number(args.endLine) || start + 199);
        const lines = readFileSync(path, "utf8").split("\n");
        return observe({ path: relativePath, startLine: start, endLine: Math.min(end, lines.length), text: lines.slice(start - 1, end).join("\n") });
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
        const prepared = prepareCreateArtifact({ workspace: root, path: args.path, content: args.content, writablePaths });
        if (!prepared.ok) return observe({ ok: false, terminal: true, error: prepared.reason });
        const relativePath = relative(root, prepared.path);
        mkdirSync(dirname(prepared.path), { recursive: true });
        writeFileSync(prepared.path, prepared.content);
        const { verification, acceptance } = checks();
        if (settledChecks.verification.passed && !verification.passed) {
          unlinkSync(prepared.path);
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
        const result = runTestsCommand(root, named.command, { timeoutMs: named.timeoutMs || 120000 });
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
