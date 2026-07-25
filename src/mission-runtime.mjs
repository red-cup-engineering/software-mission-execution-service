import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createAgentTools, territorySnapshot } from "./agent-tools.mjs";
import { dispatchBatch as defaultDispatch } from "./market-client.mjs";
import { runTestsCommand } from "@emsenn/sandbox-command-execution-service";
import { appendSoftwareTrajectory, readSoftwareTrajectoryPromotion, recallSoftwareTrajectories, resolveInducedSoftwareTrajectory, trajectoryFingerprint, trajectoryRecipeFingerprint } from "@emsenn/software-trajectory-memory-service/client";
import { buildCodingContextPacket } from "@emsenn/coding-context-projection-service";
import { resolutionCreditPolicy, validateConsiderationPolicy } from "@emsenn/inference-work-lot-service/consideration";
import { executeAcceptanceCapsule, loadAcceptanceCapsule, materializeAcceptanceCapsule, validateAcceptanceCapsule } from "@emsenn/protected-acceptance-service/client";

export const ACTION_SCHEMA = {
  type: "object",
  required: ["action", "args", "reason"],
  properties: {
    action: { type: "string", enum: ["list_files", "search", "read", "edit", "create", "command", "test", "finish"] },
    args: { type: "object", additionalProperties: true },
    reason: { type: "string", minLength: 5, maxLength: 500 },
  },
  additionalProperties: false,
};

const CURRENT_WRITABLE_BYTE_CAP = 12_000;
const SMALL_EDIT_BLOCK_BYTE_CAP = 4_096;

function workspaceWritableEvidence(workspace, writablePaths = [], byteCap = CURRENT_WRITABLE_BYTE_CAP) {
  return [...new Set(writablePaths.filter((path) => typeof path === "string" && path.length > 0))]
    .sort()
    .map((path) => {
      const absolute = resolve(workspace, path);
      if (absolute !== resolve(workspace) && !absolute.startsWith(`${resolve(workspace)}${sep}`)) {
        return { path, exists: false, confined: false, byteLength: 0, text: "", truncated: false };
      }
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        return { path, exists: false, confined: true, byteLength: 0, text: "", truncated: false };
      }
      const bytes = readFileSync(absolute);
      return {
        path,
        exists: true,
        confined: true,
        byteLength: bytes.byteLength,
        digest: createHash("sha256").update(bytes).digest("hex"),
        text: bytes.subarray(0, byteCap).toString("utf8"),
        truncated: bytes.byteLength > byteCap,
      };
    });
}

function relevanceTokens(value) {
  return new Set(String(value ?? "").toLowerCase().match(/[a-z][a-z0-9_-]{2,}/gu) ?? []);
}

function currentSearchAnchors(evidence, relevance = "") {
  if (!evidence?.exists || typeof evidence.text !== "string") return [];
  const counts = new Map();
  const lines = evidence.text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    for (let width = 1; width <= 4 && index + width <= lines.length; width += 1) {
      const source = lines.slice(index, index + width).join("\n");
      if (!source || Buffer.byteLength(source) > SMALL_EDIT_BLOCK_BYTE_CAP) continue;
      const prior = counts.get(source);
      counts.set(source, prior ? { ...prior, count: prior.count + 1 } : { count: 1, index, width });
    }
  }
  const wanted = relevanceTokens(relevance);
  return [...counts]
    .filter(([, { count }]) => count === 1)
    .map(([line, { index, width }]) => ({
      line,
      index,
      width,
      score: [...relevanceTokens(line)].reduce((total, token) => total + (wanted.has(token) ? 1 : 0), 0),
      leadingScore: [...relevanceTokens(lines[index])].reduce((total, token) => total + (wanted.has(token) ? 1 : 0), 0),
    }))
    .sort((left, right) => right.score - left.score || right.leadingScore - left.leadingScore || right.width - left.width || left.index - right.index)
    .slice(0, 2)
    .map(({ line }) => ({
      id: `a-${createHash("sha256").update(line).digest("hex").slice(0, 16)}`,
      search: line,
    }));
}

function editBlockSchema({ targetMissing = false, allowedAnchors = [] } = {}) {
  return {
    type: "object",
    required: ["anchor", "replace"],
    properties: {
      anchor: targetMissing
        ? { type: "string", const: "absent" }
        : allowedAnchors.length
          ? { type: "string", enum: allowedAnchors.map(({ id }) => id) }
          : { type: "string", pattern: "^a-[0-9a-f]{16}$" },
      // Provider grammars differ on string-length keywords. The host admits
      // nonempty bounded bytes against the current artifact after generation.
      replace: { type: "string" },
    },
    additionalProperties: false,
  };
}

export function softwareEditActionSchema(writablePaths = [], workspaceEvidence = [], relevance = "") {
  const paths = [...new Set(writablePaths.filter((path) => typeof path === "string" && path.length > 0))];
  const existing = paths.filter((path) => workspaceEvidence.find((artifact) => artifact?.path === path)?.exists !== false);
  const absent = paths.filter((path) => workspaceEvidence.find((artifact) => artifact?.path === path)?.exists === false);
  const editArgumentAlternatives = existing.map((path) => {
      const evidence = workspaceEvidence.find((artifact) => artifact?.path === path);
      const block = editBlockSchema({ allowedAnchors: currentSearchAnchors(evidence, relevance) });
      return {
        type: "object", required: ["path", "blocks"],
        properties: { path: path ? { type: "string", const: path } : { type: "string", minLength: 1 }, blocks: block },
        additionalProperties: false,
      };
    });
  const editArgs = editArgumentAlternatives.length === 1
    ? editArgumentAlternatives[0]
    : { oneOf: editArgumentAlternatives };
  const alternatives = [];
  if (existing.length) alternatives.push({
    type: "object",
    properties: { action: { type: "string", const: "edit" }, args: editArgs },
    required: ["action", "args"],
    additionalProperties: false,
  });
  if (absent.length) alternatives.push({
    type: "object",
    properties: {
      action: { type: "string", const: "create" },
      args: absent.length === 1 ? {
        type: "object", required: ["path", "content"],
        properties: { path: { type: "string", const: absent[0] }, content: { type: "string" } },
        additionalProperties: false,
      } : { oneOf: absent.map((path) => ({
        type: "object", required: ["path", "content"],
        properties: { path: { type: "string", const: path }, content: { type: "string" } },
        additionalProperties: false,
      })) },
    },
    required: ["action", "args"],
    additionalProperties: false,
  });
  if (alternatives.length === 1) return alternatives[0];
  return {
    type: "object",
    oneOf: alternatives,
  };
}

const SYSTEM = `You are the inference interior of one bounded software process node operating an isolated copy of one admitted territory. Invoke exactly one tool once using the contracted JSON. Available actions:
list_files {path?,max?}; search {query,path?}; read {path,startLine?,endLine?}; edit {path,blocks}; create {path,content}; command {name}; test {}; finish {summary?}.
Include only the arguments used by the selected action. For edit, blocks are one {search,replace} object or a nonempty ordered array of small exact blocks; do not put marker text inside either field. Search is an exact nonempty current substring. The host decodes the JSON string before applying replace: source-language quote characters belong directly in the decoded replacement; never add a literal backslash before them. For a target marked absent, use create with nonempty content. Never replace an entire source artifact. The host presents current writable bytes again on every contact; work from those bytes, not an earlier packet. A readout is one transition and the next contact receives its observation. You have no shell. Do not explore operational data records unless the objective names them. Make the smallest correct change. The host automatically runs the declared verification after every edit. Never claim success without a passing verification result.`;

function parseAction(record) {
  if (!record || typeof record.text !== "string") return null;
  let value;
  try { value = JSON.parse(record.text); } catch { return null; }
  const aliases = { read_file: "read", list_dir: "list_files", edit_file: "edit", create_file: "create", run_test: "test", apply_patch: "edit" };
  if (typeof value.action === "string") return { action: aliases[value.action] || value.action, args: value.args && typeof value.args === "object" ? value.args : Object.fromEntries(Object.entries(value).filter(([key]) => !["action", "reason"].includes(key))), reason: value.reason || "provider selected this next tool move" };
  if (typeof value.command === "string") return { action: aliases[value.command] || value.command, args: Object.fromEntries(Object.entries(value).filter(([key]) => !["command", "reason"].includes(key))), reason: value.reason || "provider selected this next tool move" };
  for (const name of ["list_files", "list_dir", "search", "read", "read_file", "edit", "edit_file", "create", "create_file", "test", "run_test", "finish"]) {
    if (value[name] !== undefined) return { action: aliases[name] || name, args: value[name] && typeof value[name] === "object" ? value[name] : {}, reason: value.reason || "provider selected this next tool move" };
  }
  if (typeof value.path === "string") return { action: value.blocks !== undefined ? "edit" : value.content !== undefined ? "create" : "read", args: value, reason: value.blocks !== undefined ? "provider supplied a source edit" : value.content !== undefined ? "provider supplied a source creation" : "provider selected a source path to inspect" };
  return null;
}

function actionBlocks(action) {
  if (action?.action !== "edit") return null;
  const blocks = action.args?.blocks;
  return Array.isArray(blocks) ? blocks : blocks && typeof blocks === "object" ? [blocks] : null;
}

function validateCurrentEdit(action, processNode, writablePaths) {
  if (action?.action !== "edit") return null;
  const path = action.args?.path;
  if (typeof path !== "string" || !writablePaths.includes(path)) return `edit path is outside declared writable paths: ${path || "(missing)"}`;
  const blocks = actionBlocks(action);
  if (!blocks?.length) return "edit requires one or more exact blocks";
  const evidence = workspaceWritableEvidence(processNode.workspace, [path])[0];
  if (!evidence?.confined) return "edit path escapes the process-node workspace";
  let current = evidence.exists ? readFileSync(resolve(processNode.workspace, path), "utf8") : "";
  if (!evidence.exists) return "edit requires an existing current target; use the distinct create action for an absent target";
  for (const block of blocks) {
    if (!block || typeof block.search !== "string" || typeof block.replace !== "string" || !block.replace.length) return "each edit block requires nonempty string replacement and string search";
    if (block.search === "") return "edit search must be a nonempty exact current substring";
    if (Buffer.byteLength(block.search) > SMALL_EDIT_BLOCK_BYTE_CAP || (evidence.exists && Buffer.byteLength(block.replace) > SMALL_EDIT_BLOCK_BYTE_CAP)) return `existing-file edit blocks may carry at most ${SMALL_EDIT_BLOCK_BYTE_CAP} bytes per side`;
    if (block.search === current) return "complete-source replacement is not a lawful small edit block";
    const at = current.indexOf(block.search);
    if (at < 0) return "edit search is not present in the evolving current source";
    if (current.indexOf(block.search, at + block.search.length) >= 0) return "edit search is ambiguous in the evolving current source";
    current = `${current.slice(0, at)}${block.replace}${current.slice(at + block.search.length)}`;
  }
  return null;
}

function validateCurrentCreate(action, processNode, writablePaths) {
  if (action?.action !== "create") return null;
  const path = action.args?.path;
  if (typeof path !== "string" || !writablePaths.includes(path)) return `create path is outside declared writable paths: ${path || "(missing)"}`;
  if (typeof action.args?.content !== "string" || !action.args.content.length) return "create requires nonempty string content";
  if (Buffer.byteLength(action.args.content) > CURRENT_WRITABLE_BYTE_CAP) return `create content may carry at most ${CURRENT_WRITABLE_BYTE_CAP} bytes`;
  const evidence = workspaceWritableEvidence(processNode.workspace, [path])[0];
  if (!evidence?.confined) return "create path escapes the process-node workspace";
  if (evidence.exists) return "create requires a target absent from the current process-node workspace";
  return null;
}

function validateCurrentAction(action, processNode, writablePaths) {
  return validateCurrentEdit(action, processNode, writablePaths) ?? validateCurrentCreate(action, processNode, writablePaths);
}

function transitionFingerprint(processNode, action) {
  return createHash("sha256").update(JSON.stringify({
    action,
    writableWorkspace: workspaceWritableEvidence(processNode.workspace, processNode.writablePaths)
      .map(({ path, exists, byteLength, digest }) => ({ path, exists, byteLength, digest: digest ?? null })),
  })).digest("hex");
}

function providerNativeReceipt(record) {
  const receipt = record?.providerNativeReceipt;
  return receipt && typeof receipt === "object" && !Array.isArray(receipt) && typeof receipt.type === "string" && receipt.type.length > 0
    ? receipt
    : null;
}

function copyTerritory(source) {
  const parent = mkdtempSync(join(tmpdir(), "union-dev-process-node-")), workspace = join(parent, "territory");
  cpSync(source, workspace, { recursive: true, filter: (path) => !path.split(/[\\/]/).some((part) => [".git", "node_modules", ".lake", "dist", "coverage"].includes(part)) });
  const installedDependencies = join(source, "node_modules");
  if (existsSync(installedDependencies)) cpSync(installedDependencies, join(workspace, "node_modules"), { recursive: true, dereference: true });
  return { parent, workspace };
}

export function inferenceContextProjection(contextPacket) {
  // The host retains the complete packet and its digest. The inference die
  // needs exact source, purpose, lane and oracle bytes, not a second copy of
  // host-only schemas, metrology, inventories, or quality attestations.
  return {
    type: contextPacket.type,
    identity: contextPacket.identity,
    objective: contextPacket.objective,
    machineChecks: {
      verifyCommand: contextPacket.machineChecks?.verifyCommand,
      acceptanceCommand: contextPacket.machineChecks?.acceptanceCommand,
      baselineVerification: contextPacket.machineChecks?.baselineVerification && {
        passed: contextPacket.machineChecks.baselineVerification.passed,
        output: String(contextPacket.machineChecks.baselineVerification.output ?? "").slice(-2400),
      },
      baselineAcceptance: contextPacket.machineChecks?.acceptanceCommand === contextPacket.machineChecks?.verifyCommand
        ? { passed: contextPacket.machineChecks?.baselineAcceptance?.passed, sameAsBaselineVerification: true }
        : contextPacket.machineChecks?.baselineAcceptance && {
            passed: contextPacket.machineChecks.baselineAcceptance.passed,
            output: String(contextPacket.machineChecks.baselineAcceptance.output ?? "").slice(-2400),
          },
    },
    acceptanceTestVectors: contextPacket.acceptanceTestVectors,
    acceptanceAuthority: contextPacket.acceptanceAuthority,
    lane: contextPacket.lane,
    targetArtifacts: contextPacket.targetArtifacts,
    evidenceArtifacts: contextPacket.evidenceArtifacts.map((artifact) => (
      artifact.role === "machine-check-target"
        ? {
            path: artifact.path,
            role: artifact.role,
            digest: artifact.digest,
            bytes: artifact.bytes,
            truncated: artifact.truncated,
            heldByHost: true,
          }
        : artifact
    )),
    omittedArtifacts: contextPacket.omittedArtifacts,
    priorVerifiedKnowledge: (contextPacket.priorVerifiedKnowledge ?? [])
      .filter((memory) => memory.taskClass && memory.taskClass === contextPacket.identity?.taskClass),
    // Market/transport refusals steer the host's next procurement; they are
    // not software evidence and must not recursively enlarge later prompts.
    priorResidueKnowledge: (contextPacket.priorResidueKnowledge ?? []).filter((residue) => (
      /schema-assay|invalid-action|malformed-action/u.test(residue?.dominantRefusal ?? "")
    )),
    constraints: contextPacket.constraints,
    firstMoves: contextPacket.firstMoves,
    packetQuality: contextPacket.packetQuality,
  };
}

function outputContractLearning(outputSchema, residueKnowledge = []) {
  const properties = outputSchema?.properties && typeof outputSchema.properties === "object" ? outputSchema.properties : {};
  const args = properties.args ?? {};
  const argsAlternatives = Array.isArray(args.oneOf) ? args.oneOf : [args];
  const priorAssayProblems = [...new Set(residueKnowledge
    .flatMap((residue) => Array.isArray(residue?.latestProblems) && residue.latestProblems.length ? residue.latestProblems : Array.isArray(residue?.problems) ? residue.problems : [])
    .filter((problem) => typeof problem === "string" && problem)
    .map((problem) => problem.slice(0, 1000)))]
    .slice(0, 32);
  return {
    type: "CurrentOutputContractLearning",
    currentContract: {
      requiredRootFields: Array.isArray(outputSchema?.required) ? outputSchema.required : [],
      allowedRootFields: Object.keys(properties),
      additionalRootFieldsAllowed: outputSchema?.additionalProperties !== false,
      action: properties.action?.const ?? properties.action?.enum ?? null,
      requiredArgumentFields: [...new Set(argsAlternatives.flatMap((alternative) => alternative?.required ?? []))].sort(),
    },
    priorAssayProblems,
    rule: "Prior assay problems describe rejected earlier outputs; they are not the current task and must not be answered as content. Return only the current contracted object, with every current required field and no forbidden field.",
  };
}

function actionContractLearning(residueKnowledge = []) {
  const priorActionRefusals = [...new Set(residueKnowledge
    .filter((residue) => /invalid-action|malformed-action/u.test(residue?.dominantRefusal ?? ""))
    .flatMap((residue) => Array.isArray(residue?.latestReasons) && residue.latestReasons.length ? residue.latestReasons : Array.isArray(residue?.reasons) ? residue.reasons : [])
    .filter((reason) => typeof reason === "string" && reason)
    .map((reason) => reason.slice(0, 1000)))]
    .slice(0, 16);
  return {
    type: "CurrentActionContractLearning",
    priorActionRefusals,
    editGrounding: [
      "args.path names the artifact being edited.",
      "blocks.anchor must be one host-issued identity from that artifact's CURRENT EDIT ANCHORS; the host resolves it to exact current source bytes.",
      "Objective, constraint, routing, rationale, residue, observation, and metadata prose are never source bytes.",
      "blocks.replace must directly implement the objective at the selected source location; it is not a paraphrase or copied instruction.",
    ],
  };
}

export function processNodePrompt(processNode, contextPacket, outputSchema = ACTION_SCHEMA) {
  const compactObservation = (source) => {
    let value;
    try { value = JSON.parse(source); } catch { return String(source).slice(-2400); }
    const verification = value?.verification;
    const acceptance = value?.acceptance;
    return JSON.stringify({
      ...(value?.ok != null ? { ok: value.ok } : {}),
      ...(value?.terminal != null ? { terminal: value.terminal } : {}),
      ...(value?.error ? { error: String(value.error).slice(-1200) } : {}),
      ...(value?.editBlocks != null ? { editBlocks: value.editBlocks } : {}),
      ...(verification ? {
        verification: {
          passed: verification.passed === true,
          output: String(verification.output ?? "").slice(-2400),
        },
      } : {}),
      ...(acceptance ? {
        acceptance: acceptance.output === verification?.output
          ? { passed: acceptance.passed === true, sameAsVerification: true }
          : { passed: acceptance.passed === true, output: String(acceptance.output ?? "").slice(-1200) },
      } : {}),
    });
  };
  const recent = processNode.observations.slice(-5).map((x, i) => `Observation ${i + 1}: ${compactObservation(x)}`).join("\n");
  const writablePaths = contextPacket.lane?.writablePaths ?? [];
  const hasWorkspace = typeof processNode.workspace === "string";
  const writableWorkspace = hasWorkspace ? workspaceWritableEvidence(processNode.workspace, writablePaths) : [];
  const actionRelevance = [contextPacket.objective, ...processNode.observations.slice(-3)].join("\n");
  const projection = inferenceContextProjection(contextPacket);
  if (hasWorkspace) projection.evidenceArtifacts = projection.evidenceArtifacts.filter((artifact) => !writablePaths.includes(artifact.path));
  return [
    "CODING CONTEXT PACKET (host-compiled; initial evidence is retained for purpose and oracle context):",
    JSON.stringify(projection),
    "CURRENT ADMITTED WRITABLE WORKSPACE (refreshed at this contact; UTF-8 prefix is deterministically capped per artifact):",
    JSON.stringify({
      byteCap: CURRENT_WRITABLE_BYTE_CAP,
      artifacts: writableWorkspace.map((artifact) => ({
        path: artifact.path,
        exists: artifact.exists,
        confined: artifact.confined,
        byteLength: artifact.byteLength,
        digest: artifact.digest,
        truncated: artifact.truncated,
        editAnchors: artifact.exists ? currentSearchAnchors(artifact, actionRelevance) : [{ id: "absent", search: "" }],
      })),
      law: "Return one exact edit transition. The displayed anchors are the admitted current-source projection; select one anchor identity and the host resolves it against the complete current artifact. The absent anchor is lawful only for a target marked exists:false. Every replacement must differ and the resulting workspace must satisfy the stated objective and acceptance test vectors.",
    }),
    "LEARNED OUTPUT CORRECTIONS (host-compiled from prior customer schema assays and the current contract):",
    JSON.stringify(outputContractLearning(outputSchema, projection.priorResidueKnowledge)),
    "LEARNED ACTION CORRECTIONS (host-compiled from prior host refusals and the current writable bytes):",
    JSON.stringify(actionContractLearning(projection.priorResidueKnowledge)),
    "CURRENT PROCESS-NODE TRAJECTORY:",
    recent || "No tool observations yet. Follow the packet's firstMoves before requesting more evidence.",
  ].join("\n\n");
}

function resolveContractEdit(action, processNode, writablePaths, relevance = "") {
  if (action?.action !== "edit") return action;
  const path = action.args?.path;
  if (typeof path !== "string" || !writablePaths.includes(path)) return action;
  const evidence = workspaceWritableEvidence(processNode.workspace, [path])[0];
  const anchors = new Map(currentSearchAnchors(evidence, relevance).map(({ id, search }) => [id, search]));
  if (evidence?.exists === false) anchors.set("absent", "");
  const blocks = Array.isArray(action.args?.blocks) ? action.args.blocks : [action.args?.blocks];
  if (!blocks.length || blocks.some((block) => !block || typeof block.anchor !== "string" || !anchors.has(block.anchor))) return action;
  const resolvedBlocks = blocks.map(({ anchor, replace }) => ({ search: anchors.get(anchor), replace }));
  return {
    ...action,
    args: {
      ...action.args,
      blocks: Array.isArray(action.args.blocks) ? resolvedBlocks : resolvedBlocks[0],
    },
  };
}

function considerationSpent(procurements = []) {
  const spent = new Map();
  for (const { consideration } of procurements) {
    for (const obligation of consideration?.obligations ?? []) {
      if (!Number.isSafeInteger(obligation?.amount) || obligation.amount < 0 || typeof obligation.asset !== "string") continue;
      spent.set(obligation.asset, (spent.get(obligation.asset) ?? 0) + obligation.amount);
    }
  }
  return spent;
}

function remainingConsiderationPolicy(perContactPolicy, aggregateBudget, procurements = []) {
  const spent = considerationSpent(procurements);
  const budgetByAsset = new Map();
  for (const alternative of aggregateBudget.acceptableAlternatives) {
    for (const obligation of alternative.obligations) {
      const prior = budgetByAsset.get(obligation.asset);
      budgetByAsset.set(obligation.asset, prior === undefined ? obligation.maximumAmount : Math.max(prior, obligation.maximumAmount));
    }
  }
  const acceptableAlternatives = perContactPolicy.acceptableAlternatives.map((alternative) => ({
    ...alternative,
    obligations: alternative.obligations.map((obligation) => ({
      ...obligation,
      maximumAmount: Math.min(obligation.maximumAmount, Math.max(0, (budgetByAsset.get(obligation.asset) ?? 0) - (spent.get(obligation.asset) ?? 0))),
    })),
  })).filter((alternative) => alternative.obligations.every((obligation) => obligation.maximumAmount > 0));
  return acceptableAlternatives.length ? { ...perContactPolicy, acceptableAlternatives } : null;
}

function jobFor(manifest, processNode, contextPacket, considerationPolicy = manifest.considerationPolicy) {
  const actionRelevance = [manifest.objective, ...processNode.observations.slice(-3)].join("\n");
  const latestObservation = (() => {
    try { return JSON.parse(processNode.observations.at(-1) ?? "null"); } catch { return null; }
  })();
  const untouchedPaths = manifest.writablePaths.filter((path) => !processNode.tools.changed.has(path));
  const acceptanceNamedPaths = manifest.writablePaths.filter((path) => manifest.acceptanceCommand.includes(path));
  const editPaths = latestObservation?.verification?.passed === true
      && latestObservation?.acceptance?.passed === false
    ? acceptanceNamedPaths.length
      ? acceptanceNamedPaths
      : untouchedPaths.length
        ? [...untouchedPaths, ...manifest.writablePaths.filter((path) => processNode.tools.changed.has(path))]
        : manifest.writablePaths
    : manifest.writablePaths;
  const outputSchema = manifest.workType === "software-engineering"
    ? softwareEditActionSchema(editPaths, workspaceWritableEvidence(processNode.workspace, editPaths), actionRelevance)
    : ACTION_SCHEMA;
  return {
    id: `${manifest.id}:${processNode.contacts + 1}`,
    workType: manifest.inferenceWorkType,
    requiredCapabilities: manifest.inferenceRequiredCapabilities,
    difficulty: manifest.difficulty ?? 0.45,
    maxTokens: manifest.maxTokens ?? 700,
    considerationPolicy,
    routingProfile: manifest.routingProfile,
    extendedRoutingRationale: manifest.extendedRoutingRationale,
    ...(manifest.supplierExclusions.length ? { excludeProviders: manifest.supplierExclusions } : {}),
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: processNodePrompt(processNode, contextPacket, outputSchema) }],
    outputContract: { format: "json", ...(manifest.enforceProviderSchema ? { mode: "json_schema" } : {}), schema: outputSchema },
  };
}

function normalizeTestVectors(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 32).map((vector, index) => {
    if (!vector || typeof vector !== "object" || Array.isArray(vector)) throw new Error(`test vector ${index + 1} must be an object`);
    const id = typeof vector.id === "string" ? vector.id.trim() : "";
    const given = Array.isArray(vector.given) ? vector.given.filter((value) => typeof value === "string" && value.trim()).slice(0, 16) : [];
    const when = typeof vector.when === "string" ? vector.when.trim() : "";
    const then = Array.isArray(vector.then) ? vector.then.filter((value) => typeof value === "string" && value.trim()).slice(0, 16) : [];
    const forbidden = Array.isArray(vector.forbidden) ? vector.forbidden.filter((value) => typeof value === "string" && value.trim()).slice(0, 16) : [];
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(id) || given.length === 0 || !when || then.length === 0) {
      throw new Error(`test vector ${index + 1} requires a lowercase id, nonempty given, when, and then fields`);
    }
    return { id, given, when, then, forbidden };
  });
}

function replayInducedTrajectory(manifest, resolver, acceptanceCapsule) {
  const isolated = copyTerritory(manifest.territory);
  if (acceptanceCapsule) materializeAcceptanceCapsule(isolated.workspace, acceptanceCapsule);
  const tools = createAgentTools({ root: isolated.workspace, verifyCommand: manifest.verifyCommand, acceptanceCommand: manifest.acceptanceCommand, commands: manifest.commands, writablePaths: manifest.writablePaths, readablePaths: manifest.readablePaths });
  const observations = [];
  for (const action of resolver.actions) {
    const editError = validateCurrentAction(action, { workspace: isolated.workspace }, manifest.writablePaths);
    if (editError) {
      observations.push(JSON.stringify({ terminal: true, error: editError }));
      break;
    }
    try { observations.push(tools.execute(action)); }
    catch (error) { observations.push(JSON.stringify({ error: error.message })); break; }
  }
  const checks = tools.verify();
  const verified = tools.changed.size > 0 && checks.verification.passed && checks.acceptance.passed;
  return {
    id: `resolver:${resolver.resolverId}`,
    ...isolated,
    tools,
    observations,
    actions: resolver.actions,
    providers: [],
    procurements: [],
    status: verified ? "verified" : "resolver-miss",
    completions: 0,
    deterministicResolver: { id: resolver.resolverId, fingerprint: resolver.dominantFingerprint, witnesses: resolver.witnesses, replayVerified: verified },
  };
}

export async function runMission(input, {
  dispatch = defaultDispatch,
  dataRoot,
  rwilAgentUrl = process.env.RWIL_RDF_AGENT,
  keepWorkspaces = false,
  onEvent = () => {},
  appendTrajectory = appendSoftwareTrajectory,
  recallTrajectories = recallSoftwareTrajectories,
  resolveInducedTrajectory = resolveInducedSoftwareTrajectory,
  promotionReadout = readSoftwareTrajectoryPromotion,
  signal,
} = {}) {
  const territory = resolve(input.territory);
  if (input.acceptanceCapsule && input.acceptanceCapsulePath) throw new Error("mission must carry an acceptance capsule by value or path, not both");
  const acceptanceCapsule = input.acceptanceCapsule
    ? validateAcceptanceCapsule(input.acceptanceCapsule, { territory })
    : input.acceptanceCapsulePath ? loadAcceptanceCapsule(input.acceptanceCapsulePath, { territory }) : null;
  if (acceptanceCapsule && input.acceptanceCommand && input.acceptanceCommand !== acceptanceCapsule.command) throw new Error("mission acceptance command conflicts with protected acceptance capsule");
  if (acceptanceCapsule && Array.isArray(input.testVectors) && JSON.stringify(normalizeTestVectors(input.testVectors)) !== JSON.stringify(acceptanceCapsule.testVectors)) throw new Error("mission test vectors conflict with protected acceptance capsule");
  const manifest = {
    id: input.id || `urn:ame:software-mission-execution-service:mission:${randomUUID()}`,
    objective: input.objective,
    taskClass: input.taskClass || null,
    focusPaths: Array.isArray(input.focusPaths) ? [...new Set(input.focusPaths.filter((value) => typeof value === "string" && value))].slice(0, 32) : [],
    writablePaths: Array.isArray(input.writablePaths) ? [...new Set(input.writablePaths.filter((value) => typeof value === "string" && value))].slice(0, 32) : [],
    readablePaths: Array.isArray(input.readablePaths) ? [...new Set(input.readablePaths.filter((value) => typeof value === "string" && value))].slice(0, 32) : [],
    workType: typeof input.workType === "string" && input.workType ? input.workType : "classification",
    requiredCapabilities: Array.isArray(input.requiredCapabilities) && input.requiredCapabilities.length
      ? [...new Set(input.requiredCapabilities.filter((value) => typeof value === "string" && value))]
      : ["classification", input.enforceProviderSchema === true ? "json-schema-output" : "json-output"],
    inferenceWorkType: typeof input.inferenceWorkType === "string" && input.inferenceWorkType
      ? input.inferenceWorkType
      : "inquiry",
    inferenceRequiredCapabilities: Array.isArray(input.inferenceRequiredCapabilities) && input.inferenceRequiredCapabilities.length
      ? [...new Set(input.inferenceRequiredCapabilities.filter((value) => typeof value === "string" && value))]
      : ["inquiry", "json-output", ...(input.enforceProviderSchema === true ? ["json-schema-output"] : [])],
    territory,
    verifyCommand: input.verifyCommand,
    acceptanceCommand: acceptanceCapsule?.command || input.acceptanceCommand || input.verifyCommand,
    commands: input.commands || {},
    constraints: input.constraints || [],
    testVectors: acceptanceCapsule?.testVectors || normalizeTestVectors(input.testVectors),
    acceptanceCapsule,
    acceptanceCapsulePath: input.acceptanceCapsulePath || null,
    difficulty: input.difficulty,
    maxTokens: input.maxTokens,
    considerationPolicy: validateConsiderationPolicy(input.considerationPolicy ?? resolutionCreditPolicy(31)),
    considerationBudget: validateConsiderationPolicy(input.considerationBudget ?? input.considerationPolicy ?? resolutionCreditPolicy(31)),
    enforceProviderSchema: input.enforceProviderSchema === true,
    providerTimeoutMs: input.providerTimeoutMs == null ? null : (() => {
      if (!Number.isSafeInteger(input.providerTimeoutMs) || input.providerTimeoutMs <= 0) {
        throw new Error("providerTimeoutMs must be a positive safe integer when supplied");
      }
      return input.providerTimeoutMs;
    })(),
    routingProfile: input.routingProfile ?? "bounded",
    extendedRoutingRationale: input.extendedRoutingRationale ?? null,
    supplierExclusions: Array.isArray(input.supplierExclusions) ? [...new Set(input.supplierExclusions.filter((value) => typeof value === "string" && value))].slice(0, 32) : [],
    requireStrongContext: input.requireStrongContext !== false,
  };
  if (!manifest.objective || !manifest.verifyCommand || !existsSync(manifest.territory)) throw new Error("mission requires objective, existing territory, and verifyCommand");
  if (manifest.workType === "software-engineering" && manifest.writablePaths.length === 0) throw new Error("software-engineering missions require an explicit nonempty writable lane");
  if (!["bounded", "extended"].includes(manifest.routingProfile)) throw new Error("mission routingProfile must be bounded or extended");
  if (manifest.routingProfile === "extended" && (typeof manifest.extendedRoutingRationale !== "string"
      || manifest.extendedRoutingRationale.trim().length < 8 || manifest.extendedRoutingRationale.length > 2000)) {
    throw new Error("an extended software mission requires one bounded customer rationale");
  }
  if (manifest.routingProfile === "bounded" && manifest.extendedRoutingRationale !== null) throw new Error("a bounded software mission cannot carry an extended routing rationale");
  if (acceptanceCapsule) {
    if (manifest.writablePaths.length === 0) throw new Error("protected acceptance missions require an explicit nonempty writable lane");
    const conflicts = acceptanceCapsule.artifacts.filter((artifact) => manifest.writablePaths.some((path) => artifact.path === path || artifact.path.startsWith(`${path}/`) || path.startsWith(`${artifact.path}/`)));
    if (conflicts.length) throw new Error(`protected acceptance artifacts overlap the writable lane: ${conflicts.map((artifact) => artifact.path).join(", ")}`);
  }
  const startedAt = new Date().toISOString(), snapshot = territorySnapshot(manifest.territory);
  const baselineVerification = runTestsCommand(manifest.territory, manifest.verifyCommand);
  const baselineAcceptance = acceptanceCapsule
    ? executeAcceptanceCapsule(manifest.territory, acceptanceCapsule, { requireSourceEvidence: true })
    : manifest.acceptanceCommand === manifest.verifyCommand ? baselineVerification : runTestsCommand(manifest.territory, manifest.acceptanceCommand);
  const memoryOptions = { dataRoot, agentCardUrl: process.env.SOFTWARE_TRAJECTORY_MEMORY_AGENT_CARD_URL };
  const memories = signal?.aborted ? [] : await recallTrajectories(manifest.objective, { ...memoryOptions, taskClass: manifest.taskClass });
  const contextPacket = buildCodingContextPacket({ manifest, snapshot, baselineVerification, baselineAcceptance, memories, actionSchema: ACTION_SCHEMA });
  if (manifest.workType === "software-engineering" && manifest.requireStrongContext && Object.values(contextPacket.packetQuality).some((value) => value !== true)) {
    const deficient = Object.entries(contextPacket.packetQuality).filter(([, value]) => value !== true).map(([key]) => key);
    throw new Error(`software-engineering context packet is deficient: ${deficient.join(", ")}`);
  }
  if (input.acceptAlreadySatisfied !== false && baselineVerification.passed && baselineAcceptance.passed) {
    const finishedAt = new Date().toISOString();
    const outcome = {
      verified: true,
      promotable: false,
      candidateVerified: false,
      integrated: true,
      inductionRequired: false,
      classification: "already-satisfied",
      changedPaths: [],
      selectedProcessNodeId: null,
      selectedActions: [],
      trajectoryFingerprint: null,
      trajectoryRecipeFingerprint: null,
      inducedResolver: null,
      summary: "the admitted territory already satisfies customer verification and acceptance",
      proposal: null,
      integration: { integrated: true, classification: "already-satisfied" },
    };
    const record = {
      type: "SoftwareMissionTrajectory",
      id: manifest.id,
      objective: manifest.objective,
      taskClass: manifest.taskClass,
      startedAt,
      finishedAt,
      territory: { path: manifest.territory, filesObserved: snapshot.files.length, baselineVerificationPassed: true },
      contextPacket: {
        digest: contextPacket.digest,
        evidenceArtifacts: contextPacket.evidenceArtifacts.map((artifact) => ({ path: artifact.path, role: artifact.role, digest: artifact.digest, truncated: artifact.truncated })),
        omittedArtifacts: contextPacket.omittedArtifacts,
        quality: contextPacket.packetQuality,
        acceptanceAuthority: contextPacket.acceptanceAuthority,
        resourceAccount: contextPacket.resourceAccount,
      },
      outcome,
      metrics: {
        processNodes: 0,
        inferenceContacts: 0,
        inferenceAttempts: 0,
        usefulCompletions: 0,
        verifiedCandidates: 0,
        directInteractiveModelCalls: 0,
        inducedResolverReplays: 0,
        procurementSelections: 0,
        expectedConsideration: [],
      },
      processNode: null,
    };
    const trajectoryRecord = await appendTrajectory(record, memoryOptions);
    onEvent({ type: "mission-settled", missionId: manifest.id, outcome, graphPath: trajectoryRecord.graphPath, semanticId: trajectoryRecord.documentNi });
    return {
      ...record,
      graphPath: trajectoryRecord.graphPath,
      objectPath: trajectoryRecord.objectPath,
      semanticId: trajectoryRecord.documentNi,
      promotion: await promotionReadout(manifest.taskClass, memoryOptions),
    };
  }
  const induced = signal?.aborted || input.useInducedResolver === false || contextPacket.acceptanceAuthority.protected !== true ? null : await resolveInducedTrajectory(manifest.taskClass, { ...memoryOptions, threshold: Number.isInteger(input.resolverPromotionThreshold) ? Math.max(2, input.resolverPromotionThreshold) : 5 });
  const replay = induced?.eligible ? replayInducedTrajectory(manifest, induced, acceptanceCapsule) : null;
  if (replay && replay.status !== "verified") {
    onEvent({ type: "induced-resolver-missed", missionId: manifest.id, resolverId: induced.resolverId });
    rmSync(replay.parent, { recursive: true, force: true });
  }
  onEvent({ type: "mission-started", missionId: manifest.id, startedAt, processNodes: replay?.status === "verified" ? 0 : 1, inducedResolver: replay?.status === "verified" ? induced.resolverId : null, filesObserved: snapshot.files.length, baselineVerificationPassed: baselineVerification.passed, contextPacket: { digest: contextPacket.digest, evidenceArtifacts: contextPacket.evidenceArtifacts.length, quality: contextPacket.packetQuality } });
  const processNode = replay?.status === "verified" ? replay : (() => {
    const isolated = copyTerritory(manifest.territory);
    if (acceptanceCapsule) materializeAcceptanceCapsule(isolated.workspace, acceptanceCapsule);
    return {
      id: "process-node",
      ...isolated,
      tools: createAgentTools({ root: isolated.workspace, verifyCommand: manifest.verifyCommand, acceptanceCommand: manifest.acceptanceCommand, commands: manifest.commands, writablePaths: manifest.writablePaths, readablePaths: manifest.readablePaths }),
      observations: [], actions: [], providers: [], procurements: [], attempts: [], transitionFingerprints: new Set(),
      writablePaths: manifest.writablePaths, contacts: 0, status: signal?.aborted ? "stopped" : "ready", refusal: signal?.aborted ? { type: "aborted" } : null, completions: 0,
    };
  })();
  let inferenceContacts = 0, attempts = 0;
  try {
    while (processNode && !processNode.deterministicResolver && processNode.status === "ready") {
      if (signal?.aborted) {
        processNode.status = "stopped";
        processNode.refusal = { type: "aborted" };
        break;
      }
      const remainingConsideration = remainingConsiderationPolicy(manifest.considerationPolicy, manifest.considerationBudget, processNode.procurements);
      if (!remainingConsideration) {
        processNode.status = "refused";
        processNode.refusal = { type: "consideration-budget-exhausted", spent: Object.fromEntries(considerationSpent(processNode.procurements)) };
        processNode.observations.push(JSON.stringify({ terminal: true, ...processNode.refusal }));
        break;
      }
      const job = jobFor(manifest, processNode, contextPacket, remainingConsideration);
      processNode.contacts += 1;
      inferenceContacts += 1;
      onEvent({ type: "process-node-inference-started", missionId: manifest.id, processNodeId: processNode.id, contact: processNode.contacts, jobId: job.id });
      let records = [];
      let dispatchAbort = null;
      try {
        records = await dispatch([job], { concurrency: 1, timeoutMs: manifest.providerTimeoutMs, signal });
      } catch (error) {
        if (signal?.aborted || error?.name === "AbortError") {
          dispatchAbort = error;
          records = [];
        } else {
          records = [{ id: job.id, refusal: { type: "dispatch-error", reason: error.message }, attempts: [] }];
        }
      }
      const record = records.find((candidate) => candidate.id === job.id);
      const contactAttempts = Array.isArray(record?.attempts) ? record.attempts : [];
      processNode.attempts.push(...contactAttempts.map((attempt, ordinal) => ({ contact: processNode.contacts, jobId: job.id, ordinal: ordinal + 1, ...attempt })));
      attempts += contactAttempts.length;
      const procurement = record?.procurement ?? {};
      processNode.procurements.push({
        contact: processNode.contacts, jobId: job.id,
        provider: record?.provider || null, endpoint: record?.endpoint || null, model: record?.model || null,
        consideration: record?.cost || null, providerNativeReceipt: providerNativeReceipt(record),
        market: procurement.market ?? null, request: procurement.request ?? null, result: procurement.result ?? null,
        selectedOffer: procurement.selectedOffer ?? null, compact: procurement.compact ?? null,
        providerProposal: procurement.providerProposal ?? null, settlement: procurement.settlement ?? null,
        receipt: procurement.receipt ?? null, schemaAssay: procurement.schemaAssay ?? record?.verification?.schemaAssay ?? null,
        considerationDisposition: procurement.considerationDisposition ?? null, selectionRule: procurement.selectionRule ?? null,
        rankedFeasibleOffers: procurement.rankedFeasibleOffers ?? [],
      });
      onEvent({ type: "process-node-inference-settled", missionId: manifest.id, processNodeId: processNode.id, contact: processNode.contacts, record: record ? { id: record.id, endpoint: record.endpoint || null, refusal: record.refusal?.type || null, attempts: contactAttempts.map((attempt) => ({ endpoint: attempt.endpoint, outcome: attempt.outcome, reason: attempt.reason || null, latencyMs: attempt.latencyMs })) } : null });
      if (dispatchAbort || signal?.aborted) {
        processNode.observations.push(JSON.stringify({
          contacted: true,
          aborted: true,
          contact: processNode.contacts,
          jobId: job.id,
          recordReceived: Boolean(record),
          attemptsObserved: contactAttempts.length,
          provider: record?.provider || record?.endpoint || null,
          providerNativeReceipt: providerNativeReceipt(record),
        }));
        processNode.status = "stopped";
        processNode.refusal = { type: "aborted" };
        break;
      }
      const parsedAction = parseAction(record);
      const action = resolveContractEdit(
        parsedAction,
        processNode,
        manifest.writablePaths,
        [manifest.objective, ...processNode.observations.slice(-3)].join("\n"),
      );
      if (!action || record?.refusal) {
        processNode.observations.push(`Inference refusal or invalid action: ${record?.refusal?.type || "no result"}${record?.refusal?.reason ? `: ${record.refusal.reason}` : ""}`);
        processNode.status = "refused";
        processNode.refusal = record?.refusal ?? { type: "invalid-action-candidate" };
        onEvent({ type: "process-node-contact-refused", missionId: manifest.id, processNodeId: processNode.id, refusal: processNode.refusal });
        break;
      }
      const currentEditError = validateCurrentAction(action, processNode, manifest.writablePaths);
      if (currentEditError) {
        processNode.actions.push(action);
        processNode.providers.push(record?.provider || record?.attempts?.find((attempt) => attempt.outcome === "completion")?.provider || record?.endpoint || null);
        processNode.observations.push(JSON.stringify({ terminal: true, error: currentEditError }));
        processNode.status = "refused";
        processNode.refusal = { type: "invalid-action-candidate", reason: currentEditError };
        onEvent({ type: "process-node-action-refused", missionId: manifest.id, processNodeId: processNode.id, action: action.action, refusal: processNode.refusal });
        break;
      }
      const fingerprint = transitionFingerprint(processNode, action);
      if (processNode.transitionFingerprints.has(fingerprint)) {
        processNode.status = "stopped";
        processNode.fixedPoint = { type: "repeated-deterministic-transition", fingerprint };
        processNode.observations.push(JSON.stringify({ stopped: true, ...processNode.fixedPoint }));
        break;
      }
      processNode.transitionFingerprints.add(fingerprint);
      processNode.completions += 1;
      processNode.actions.push(action);
      processNode.providers.push(record?.provider || record?.attempts?.find((attempt) => attempt.outcome === "completion")?.provider || record?.endpoint || null);
      let observation;
      try { observation = processNode.tools.execute(action); } catch (error) { observation = JSON.stringify({ terminal: true, error: error.message }); }
      processNode.observations.push(observation);
      onEvent({ type: "process-node-action-settled", missionId: manifest.id, processNodeId: processNode.id, contact: processNode.contacts, action: action.action, endpoint: record?.endpoint || null });
      if (signal?.aborted) {
        processNode.status = "stopped";
        processNode.refusal = { type: "aborted" };
        break;
      }
      const verdict = (() => { try { return JSON.parse(observation); } catch { return null; } })();
      if (verdict?.error && verdict?.terminal === true) {
        processNode.status = "refused";
        processNode.refusal = { type: "invalid-action-candidate", reason: verdict.error };
        onEvent({ type: "process-node-action-refused", missionId: manifest.id, processNodeId: processNode.id, action: action.action, refusal: processNode.refusal });
      } else if (processNode.tools.changed.size > 0 && verdict?.verification?.passed === true && verdict?.acceptance?.passed === true) {
        processNode.status = "verified";
      }
    }
    const selected = processNode?.status === "verified" ? {
      processNodeId: processNode.id,
      changes: processNode.tools.changes(),
      actions: processNode.actions,
      observations: processNode.observations,
      completions: processNode.completions,
      providers: processNode.providers,
      deterministicResolver: processNode.deterministicResolver ?? null,
    } : null;
    const candidateAccepted = Boolean(selected);
    const proposal = selected ? {
      type: "SoftwareMissionChangeProposal",
      changes: selected.changes.map((change) => ({
        path: change.path,
        beforeExisted: change.before.existed,
        beforeDigest: `sha256:${change.before.digest}`,
        afterDigest: `sha256:${change.afterDigest}`,
        afterBytesBase64: change.after.toString("base64"),
      })),
      authorProviders: [...new Set(selected.providers.filter(Boolean))],
      trajectoryFingerprint: trajectoryFingerprint(selected.actions),
      trajectoryRecipeFingerprint: trajectoryRecipeFingerprint(selected.actions),
      deterministicResolver: selected.deterministicResolver ?? null,
      proposalOnly: true,
      customerMutation: false,
    } : null;
    const integration = {
      integrated: false,
      classification: selected ? "awaiting-receiver-induction" : "unresolved",
    };
    const finishedAt = new Date().toISOString();
    const outcome = {
      verified: candidateAccepted,
      promotable: false,
      candidateVerified: Boolean(selected),
      integrated: integration.integrated,
      inductionRequired: Boolean(selected),
      classification: integration.classification,
      changedPaths: selected?.changes.map((x) => x.path) || [],
      selectedProcessNodeId: selected?.processNodeId || null,
      selectedActions: selected?.actions || [],
      trajectoryFingerprint: selected ? trajectoryFingerprint(selected.actions) : null,
      trajectoryRecipeFingerprint: selected ? trajectoryRecipeFingerprint(selected.actions) : null,
      inducedResolver: selected?.deterministicResolver ?? null,
      summary: selected
        ? "the process node produced a verification- and customer-acceptance-passing candidate"
        : "the process node did not produce a verification-passing candidate",
      proposal,
      integration,
    };
    const record = {
      type: "SoftwareMissionTrajectory",
      id: manifest.id,
      objective: manifest.objective,
      taskClass: manifest.taskClass,
      startedAt,
      finishedAt,
      territory: { path: manifest.territory, filesObserved: snapshot.files.length, baselineVerificationPassed: baselineVerification.passed },
      contextPacket: {
        digest: contextPacket.digest,
        evidenceArtifacts: contextPacket.evidenceArtifacts.map((artifact) => ({ path: artifact.path, role: artifact.role, digest: artifact.digest, truncated: artifact.truncated })),
        omittedArtifacts: contextPacket.omittedArtifacts,
        quality: contextPacket.packetQuality,
        acceptanceAuthority: contextPacket.acceptanceAuthority,
        resourceAccount: contextPacket.resourceAccount,
      },
      outcome,
      metrics: {
        processNodes: selected?.deterministicResolver || !processNode ? 0 : 1,
        inferenceContacts,
        inferenceAttempts: attempts,
        usefulCompletions: processNode?.completions ?? 0,
        verifiedCandidates: selected ? 1 : 0,
        directInteractiveModelCalls: 0,
        inducedResolverReplays: selected?.deterministicResolver ? 1 : 0,
        procurementSelections: processNode?.procurements.length ?? 0,
        expectedConsideration: (processNode?.procurements ?? [])
          .flatMap(({ provider, consideration }) => (consideration?.obligations ?? [])
            .filter((obligation) => Number.isSafeInteger(obligation.amount) && typeof obligation.unit === "string")
            .map((obligation) => ({ provider, amount: obligation.amount, unit: obligation.unit, asset: obligation.asset ?? null, kind: obligation.kind ?? null }))),
      },
      processNode: processNode ? { id: processNode.id, status: processNode.status, refusal: processNode.refusal ?? null, actions: processNode.actions, providers: processNode.providers, procurements: processNode.procurements, attempts: processNode.attempts ?? [], observations: processNode.observations, fixedPoint: processNode.fixedPoint ?? null, deterministicResolver: processNode.deterministicResolver ?? null } : null,
    };
    const trajectoryRecord = await appendTrajectory(record, memoryOptions);
    onEvent({ type: "mission-settled", missionId: manifest.id, outcome, graphPath: trajectoryRecord.graphPath, semanticId: trajectoryRecord.documentNi });
    return {
      ...record,
      graphPath: trajectoryRecord.graphPath,
      objectPath: trajectoryRecord.objectPath,
      semanticId: trajectoryRecord.documentNi,
      promotion: await promotionReadout(manifest.taskClass, memoryOptions),
    };
  } finally {
    if (!keepWorkspaces && processNode) rmSync(processNode.parent, { recursive: true, force: true });
  }
}
