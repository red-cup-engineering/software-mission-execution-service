import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { runTestsCommand } from "@red-cup-engineering/sandbox-command-execution-service";

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function inside(root, requested) {
  const path = resolve(root, requested);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`proposal path escapes mission territory: ${requested}`);
  return path;
}

function admitted(path, writablePaths) {
  return writablePaths.some((allowed) => path === allowed || path.startsWith(`${allowed}${sep}`));
}

function restore(backups) {
  for (const { target, existed, bytes } of [...backups].reverse()) {
    if (existed) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    } else {
      rmSync(target, { force: true });
    }
  }
}

export function induceVerifiedMissionProposal(mission, result) {
  if (mission.induceVerifiedChanges === false || result?.outcome?.candidateVerified !== true) return null;
  const proposal = result.outcome?.proposal;
  if (proposal?.type !== "SoftwareMissionChangeProposal" || proposal.proposalOnly !== true
      || proposal.customerMutation !== false || !Array.isArray(proposal.changes)
      || proposal.changes.length === 0) {
    throw new Error("verified mission result lacks one proposal-only change set");
  }
  const root = resolve(mission.territory);
  const writablePaths = [...new Set((mission.writablePaths ?? []).map((path) => relative(root, inside(root, path))))];
  if (writablePaths.length === 0) throw new Error("customer induction requires an explicit writable lane");

  const seen = new Set();
  const prepared = proposal.changes.map((change) => {
    const target = inside(root, change.path);
    const path = relative(root, target);
    if (seen.has(path)) throw new Error(`proposal repeats path: ${path}`);
    seen.add(path);
    if (!admitted(path, writablePaths)) throw new Error(`proposal path is outside the customer writable lane: ${path}`);
    const after = Buffer.from(change.afterBytesBase64, "base64");
    if (digest(after) !== change.afterDigest) throw new Error(`proposal after digest mismatch: ${path}`);
    const existed = existsSync(target);
    const before = existed ? readFileSync(target) : Buffer.alloc(0);
    const currentDigest = digest(before);
    if (currentDigest === change.afterDigest) return { target, path, after, existed, before, alreadyApplied: true };
    if (existed !== change.beforeExisted || currentDigest !== change.beforeDigest) throw new Error(`proposal before-state drift: ${path}`);
    return { target, path, after, existed, before, alreadyApplied: false };
  });

  const backups = [];
  try {
    for (const change of prepared.filter(({ alreadyApplied }) => !alreadyApplied)) {
      mkdirSync(dirname(change.target), { recursive: true });
      const temporary = `${change.target}.mission-induction-${randomUUID()}`;
      writeFileSync(temporary, change.after, { flag: "wx", mode: 0o600 });
      backups.push(change);
      renameSync(temporary, change.target);
    }
    const verification = runTestsCommand(root, mission.verifyCommand);
    const acceptance = mission.acceptanceCommand === mission.verifyCommand
      ? verification
      : runTestsCommand(root, mission.acceptanceCommand ?? mission.verifyCommand);
    if (!verification.passed || !acceptance.passed) {
      restore(backups);
      throw new Error(`customer induction checks failed: ${verification.output || acceptance.output}`);
    }
    return Object.freeze({
      type: "SoftwareMissionCustomerInductionReceipt",
      providerProposal: result.semanticId ?? null,
      territory: root,
      appliedPaths: prepared.filter(({ alreadyApplied }) => !alreadyApplied).map(({ path }) => path),
      alreadyAppliedPaths: prepared.filter(({ alreadyApplied }) => alreadyApplied).map(({ path }) => path),
      verification: { passed: true },
      acceptance: { passed: true },
      inducedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (backups.length) restore(backups);
    throw error;
  }
}
