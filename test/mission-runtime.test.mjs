import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { processNodePrompt, runMission as runMissionProvider, softwareEditActionSchema } from "../src/mission-runtime.mjs";
import { createAgentTools } from "../src/agent-tools.mjs";
import { inducedTrajectoryResolver, missionMemoryContext, promotionReadout, recallTrajectories } from "@red-cup-engineering/software-trajectory-memory-service/memory";
import { prepareAcceptanceCapsule } from "@red-cup-engineering/protected-acceptance-service/acceptance-capsule";

function networkFixture() {
  const objects = new Map(), memberships = new Map();
  return {
    custody: {
      async put({ ni, bytes, mediaType }) { objects.set(ni, { ni, bytes: Buffer.from(bytes), mediaType }); return { profile: "org.red-cup-engineering.immutable-content-reference.v1", ni, key: ni, byteLength: bytes.length, mediaType }; },
      async get(reference) { return objects.get(typeof reference === "string" ? reference : reference.ni) ?? null; },
    },
    categoryIndex: {
      async add({ predicate, category, ni }) { const key = `${predicate}\n${category}`; if (!memberships.has(key)) memberships.set(key, new Set()); memberships.get(key).add(ni); return { predicate, category, ni }; },
      async query(category, { predicate }) { return { references: [...(memberships.get(`${predicate}\n${category}`) ?? [])].map((ni) => ({ ni })), continuationToken: undefined }; },
    },
  };
}
const network = networkFixture();
const trajectoryRowsByDataRoot = new Map();
const rowsFor = (input, options) => {
  const key = options.dataRoot ?? input.territory;
  if (!trajectoryRowsByDataRoot.has(key)) trajectoryRowsByDataRoot.set(key, []);
  return trajectoryRowsByDataRoot.get(key);
};

function runMission(input, options = {}) {
  const rows = rowsFor(input, options);
  const memoryOptions = () => ({ rows, ...network });
  const appendTrajectory = async (record) => {
    rows.push(record);
    return { reference: { profile: "test-witness-journal-memory", document: { ni: record.id } }, documentNi: record.id };
  };
  return runMissionProvider(input, {
    appendTrajectory,
    recallTrajectories: (objective, options) => recallTrajectories(objective, { ...options, ...memoryOptions() }),
    readMemoryContext: (objective, taskClass, missionId, sourceIdentity, options) => missionMemoryContext(objective, taskClass, missionId, sourceIdentity, { ...options, ...memoryOptions() }),
    resolveInducedTrajectory: (taskClass, options) => inducedTrajectoryResolver(taskClass, { ...options, ...memoryOptions() }),
    promotionReadout: (taskClass, options) => promotionReadout(taskClass, { ...options, ...memoryOptions() }),
    ...network,
    ...options,
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "union-dev-test-"));
  writeFileSync(join(root, "calc.mjs"), "export const add = (a, b) => a - b;\n");
  writeFileSync(join(root, "calc.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "./calc.mjs";',
    'test("adds", () => assert.equal(add(2, 3), 5));',
    "",
  ].join("\n"));
  return root;
}

function response(job, action) {
  return { id: job.id, text: JSON.stringify(action), attempts: [{ endpoint: "mock-free-cloud", outcome: "completion" }] };
}
const additionAcceptanceVector = Object.freeze({ id: "addition-acceptance", given: ["calc.mjs subtracts two operands"], when: "the implementation replaces subtraction with addition", then: ["node --test calc.test.mjs passes"], forbidden: ["customer mutation"] });

async function protectedAdditionCapsule(territory) {
  const capsule = await prepareAcceptanceCapsule({
    id: "urn:test:acceptance:protected-addition",
    objective: "Protect addition acceptance from the implementation supplier.",
    territory,
    focusPaths: ["calc.mjs"],
    command: "node --test union-acceptance/addition.test.mjs",
    testVectors: [{ id: "addition-vector", given: ["two and three"], when: "add is invoked", then: ["five is returned"], forbidden: ["subtraction"] }],
    artifacts: [{ path: "union-acceptance/addition.test.mjs", text: 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../calc.mjs";\ntest("addition-vector", () => assert.equal(add(2, 3), 5));\n' }],
  }, {
    assayOracle: async () => ({ charge: { support: true, refutation: false }, failures: [] }),
    reviewOracle: async () => ({ accepted: true, reviews: [{ endpoint: "independent-acceptance-reviewer" }] }),
  });
  const path = join(territory, "protected-addition-capsule.json");
  writeFileSync(path, JSON.stringify(capsule));
  return path;
}

test("protected capsule qualifies a source-only proposal without crossing the customer membrane", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  const capsulePath = await protectedAdditionCapsule(territory);
  const dispatch = async (jobs) => jobs.map((job) => response(job, {
    action: "edit",
    args: { path: "calc.mjs", blocks: { search: "a - b", replace: "a + b" } },
    reason: "repair source against the protected addition oracle",
  }));
  const result = await runMission({
    id: "urn:test:mission:protected-addition", objective: "Repair addition without controlling its oracle.", territory,
    verifyCommand: "node --test calc.test.mjs", acceptanceCapsulePath: capsulePath,
    focusPaths: ["calc.mjs"], writablePaths: ["calc.mjs"], readablePaths: [],
    workType: "software-engineering", requiredCapabilities: ["software-engineering", "json-schema-output"],
  }, { dispatch, dataRoot });

  assert.equal(result.outcome.integrated, false);
  assert.equal(result.outcome.inductionRequired, true);
  assert.equal(result.outcome.classification, "awaiting-receiver-induction");
  assert.equal(result.outcome.proposal.customerMutation, false);
  assert.equal(result.contextPacket.acceptanceAuthority.mode, "host-protected");
  assert.equal(existsSync(join(territory, "union-acceptance/addition.test.mjs")), false);
  assert.match(readFileSync(join(territory, "calc.mjs"), "utf8"), /a - b/);
});

test("a protected capsule may cross the exact A2A mission boundary by value", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  const capsulePath = await protectedAdditionCapsule(territory), acceptanceCapsule = JSON.parse(readFileSync(capsulePath, "utf8"));
  const dispatch = async (jobs) => jobs.map((job) => response(job, {
    action: "edit", args: { path: "calc.mjs", blocks: { search: "a - b", replace: "a + b" } }, reason: "repair against the by-value protected oracle",
  }));
  const result = await runMission({
    id: "urn:test:mission:by-value-capsule", objective: "Repair addition without controlling its oracle.", territory,
    verifyCommand: "node --test calc.test.mjs", acceptanceCapsule,
    focusPaths: ["calc.mjs"], writablePaths: ["calc.mjs"], readablePaths: [], workType: "software-engineering",
    requiredCapabilities: ["software-engineering", "json-schema-output"],
  }, { dispatch, dataRoot });
  assert.equal(result.outcome.verified, true); assert.equal(result.outcome.proposal.proposalOnly, true); assert.match(readFileSync(join(territory, "calc.mjs"), "utf8"), /a - b/u);
});

test("an isolated process node verifies against installed dependency material without write authority over it", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  const dependencyRoot = join(territory, "node_modules", "example-dependency");
  mkdirSync(dependencyRoot, { recursive: true });
  writeFileSync(join(territory, "package.json"), JSON.stringify({ type: "module", dependencies: { "example-dependency": "1.0.0" } }));
  writeFileSync(join(dependencyRoot, "package.json"), JSON.stringify({ name: "example-dependency", version: "1.0.0", type: "module", exports: "./index.mjs" }));
  writeFileSync(join(dependencyRoot, "index.mjs"), "export const correction = 6;\n");
  writeFileSync(join(territory, "calc.mjs"), 'import { correction } from "example-dependency";\nexport const add = (a, b) => a + b - correction;\n');
  writeFileSync(join(territory, "verify-with-dependency-write.mjs"), 'import assert from "node:assert/strict";\nimport { writeFileSync } from "node:fs";\nimport { add } from "./calc.mjs";\nassert.equal(add(2, 3), 5);\nif (process.cwd().includes("union-dev-process-node-")) writeFileSync(new URL("./node_modules/example-dependency/verification-touch.txt", import.meta.url), "workspace-only\\n");\n');
  const capsulePath = await protectedAdditionCapsule(territory);
  const dispatch = async (jobs) => jobs.map((job) => response(job, {
      action: "edit",
      args: { path: "calc.mjs", blocks: { search: " + b - correction", replace: " + b" } },
      reason: "repair only the admitted source while importing the installed dependency closure",
    }));

  const result = await runMission({
    id: "urn:test:mission:installed-dependency-material", objective: "Repair addition without changing installed dependencies.", territory,
    verifyCommand: "node verify-with-dependency-write.mjs", acceptanceCapsulePath: capsulePath,
    focusPaths: ["calc.mjs", "package.json"], writablePaths: ["calc.mjs"], readablePaths: ["calc.mjs", "package.json"],
    workType: "software-engineering", requiredCapabilities: ["software-engineering", "json-schema-output"],
  }, { dispatch, dataRoot });

  assert.equal(result.outcome.classification, "awaiting-receiver-induction");
  assert.equal(result.processNode.status, "verified");
  assert.equal(readFileSync(join(dependencyRoot, "index.mjs"), "utf8"), "export const correction = 6;\n");
  assert.equal(existsSync(join(dependencyRoot, "verification-touch.txt")), false);
  assert.equal(readFileSync(join(territory, "calc.mjs"), "utf8"), 'import { correction } from "example-dependency";\nexport const add = (a, b) => a + b - correction;\n');
});

test("an induced exact trajectory replays under protected acceptance with zero inference", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  const capsulePath = await protectedAdditionCapsule(territory);
  let dispatched = false;
  const resolver = {
    eligible: true,
    resolverId: "urn:sha256:induced-addition",
    dominantFingerprint: "induced-addition",
    witnesses: ["urn:witness:1", "urn:witness:2"],
    actions: [{ action: "edit", args: { path: "calc.mjs", blocks: { search: "a - b", replace: "a + b" } } }],
  };
  const result = await runMission({
    id: "urn:test:mission:induced-addition", objective: "Repair addition without controlling its oracle.", taskClass: "addition-repair", territory,
    verifyCommand: "node --test calc.test.mjs", acceptanceCapsulePath: capsulePath,
    focusPaths: ["calc.mjs"], writablePaths: ["calc.mjs"], readablePaths: [],
    workType: "software-engineering", requiredCapabilities: ["software-engineering", "json-schema-output"],
  }, {
    dataRoot,
    dispatch: async () => { dispatched = true; throw new Error("inference must not run"); },
    resolveInducedTrajectory: () => resolver,
  });

  assert.equal(dispatched, false);
  assert.equal(result.outcome.classification, "awaiting-receiver-induction");
  assert.equal(result.outcome.inducedResolver.id, resolver.resolverId);
  assert.equal(result.metrics.inferenceAttempts, 0);
  assert.equal(result.metrics.inducedResolverReplays, 1);
  assert.equal(result.metrics.processNodes, 0);
  assert.match(readFileSync(join(territory, "calc.mjs"), "utf8"), /a - b/u);
});

test("protected capsule artifact cannot be edited by the implementation supplier", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  const capsulePath = await protectedAdditionCapsule(territory);
  const dispatch = async (jobs) => jobs.map((job) => response(job, {
    action: "edit",
    args: { path: "union-acceptance/addition.test.mjs", blocks: { search: "assert.equal(add(2, 3), 5)", replace: "assert.ok(true)" } },
    reason: "weaken the protected oracle instead of repairing source",
  }));
  const result = await runMission({
    id: "urn:test:mission:oracle-capture", objective: "Attempt the observed weak-oracle incumbent.", territory,
    verifyCommand: "node --test calc.test.mjs", acceptanceCapsulePath: capsulePath,
    focusPaths: ["calc.mjs"], writablePaths: ["calc.mjs"], readablePaths: [],
    workType: "software-engineering", requiredCapabilities: ["software-engineering", "json-schema-output"],
  }, { dispatch, dataRoot });

  assert.equal(result.outcome.candidateVerified, false);
  assert.match(result.processNode.observations[0], /outside declared writable paths/);
});

test("one process-node contact verifies and records a receiver-bound proposal", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  let contacts = 0;
  const dispatch = async (jobs, options) => {
    assert.equal(Object.hasOwn(options, "concurrency"), false);
    contacts += 1;
    return jobs.map((job) => ({
      ...response(job, {
        action: "edit",
        args: { path: "calc.mjs", blocks: { search: "a - b", replace: "a + b" } },
        reason: "replace subtraction with the required addition",
      }),
      provider: "urn:provider:local-npu",
      endpoint: "urn:provider:local-npu",
      model: "qwen3:1.7b",
      receipt: "ni:///sha-256;generic-record-receipt",
      providerNativeReceipt: { type: "ProviderInferenceReceipt", inputTokens: 31, outputTokens: 7 },
      cost: { obligations: [{ amount: { numerator: "12", denominator: "1" }, unit: "relative-resolution-milliquanta-v1", asset: "urn:union:credit:relative-resolution-milliquanta-v1", kind: "credit" }] },
      procurement: {
        market: "eip155:31337:0x1111111111111111111111111111111111111111",
        request: "ni:///sha-256;request",
        result: "ni:///sha-256;result",
        selectedOffer: "ni:///sha-256;offer",
        compact: "ni:///sha-256;compact",
        providerProposal: "ni:///sha-256;proposal",
        settlement: "ni:///sha-256;settlement",
        receipt: "ni:///sha-256;receipt",
        schemaAssay: "ni:///sha-256;assay",
        considerationDisposition: "credit-issued",
        selectionRule: "least-admissible-consideration",
        rankedFeasibleOffers: [],
      },
    }));
  };
  const result = await runMission({
    id: "urn:test:mission:addition",
    objective: "Repair the add function so the declared test passes.",
    territory,
    verifyCommand: "node --test calc.test.mjs",
    testVectors: [additionAcceptanceVector],
    focusPaths: ["calc.mjs", "calc.test.mjs"],
    writablePaths: ["calc.mjs"],
  }, { dispatch, dataRoot });

  assert.equal(result.outcome.verified, true);
  assert.equal(result.outcome.integrated, false);
  assert.equal(result.outcome.classification, "awaiting-receiver-induction");
  assert.equal(result.outcome.proposal.customerMutation, false);
  assert.equal(result.metrics.directInteractiveModelCalls, 0);
  assert.equal(contacts, 1);
  assert.equal(result.metrics.processNodes, 1);
  assert.equal(result.metrics.inferenceContacts, 1);
  assert.equal(result.metrics.usefulCompletions, 1);
  assert.deepEqual(result.metrics.expectedConsideration, [{
    provider: "urn:provider:local-npu",
    amount: { numerator: "12", denominator: "1" },
    unit: "relative-resolution-milliquanta-v1",
    asset: "urn:union:credit:relative-resolution-milliquanta-v1",
    kind: "credit",
  }]);
  assert.equal(result.processNode.procurements[0].compact, "ni:///sha-256;compact");
  assert.equal(result.processNode.procurements[0].settlement, "ni:///sha-256;settlement");
  assert.equal(result.processNode.procurements[0].receipt, "ni:///sha-256;receipt");
  assert.deepEqual(result.processNode.procurements[0].providerNativeReceipt, { type: "ProviderInferenceReceipt", inputTokens: 31, outputTokens: 7 });
  assert.equal(result.processNode.procurements[0].schemaAssay, "ni:///sha-256;assay");
  assert.equal(result.processNode.procurements[0].considerationDisposition, "credit-issued");
  assert.match(readFileSync(join(territory, "calc.mjs"), "utf8"), /a - b/);
  assert.equal(result.networkReference.profile, "test-witness-journal-memory");
});

test("a schema-capable mission mechanically requests the action schema", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  let observedContract, observedPrompt;
  const dispatch = async (jobs) => {
    observedContract = jobs[0].outputContract;
    observedPrompt = jobs[0].messages[1].content;
    return jobs.map((job) => response(job, {
      action: "edit",
      args: { path: "calc.mjs", blocks: { search: "a - b", replace: "a + b" } },
      reason: "repair addition through the contracted tool schema",
    }));
  };
  await runMission({
    id: "urn:test:mission:schema-contract",
    objective: "Repair the add function through a schema-capable supplier.",
    territory,
    verifyCommand: "node --test calc.test.mjs",
    workType: "software-engineering",
    focusPaths: ["calc.mjs"],
    writablePaths: ["calc.mjs"],
    testVectors: [{ id: "schema-edit-vector", given: ["the broken source"], when: "the edit is applied", then: ["the declared check passes"], forbidden: [] }],
    requiredCapabilities: ["software-engineering", "json-schema-output"],
    enforceProviderSchema: true,
  }, { dispatch, dataRoot });

  assert.equal(observedContract.mode, "json_schema");
  assert.deepEqual(observedContract.schema, softwareEditActionSchema(["calc.mjs"], [{
    path: "calc.mjs", exists: true, truncated: false, text: readFileSync(join(territory, "calc.mjs"), "utf8"),
  }], "Repair the add function through a schema-capable supplier."));
  const editAlternative = observedContract.schema.oneOf.find((alternative) => alternative.properties.action.const === "edit");
  const editBlock = editAlternative.properties.args.oneOf[0].properties.blocks;
  assert.deepEqual(observedContract.schema.required, ["action", "args"]);
  assert.equal(observedContract.schema.properties.reason, undefined);
  assert.ok(editBlock.properties.anchor.enum.every((anchor) => /^a-[0-9a-f]{64}$/u.test(anchor)));
  assert.equal(editBlock.properties.search, undefined);
  assert.match(observedPrompt, /"editAnchors":/u);
  assert.match(observedPrompt, /export const add = \(a, b\) => a - b;/u);
  assert.equal(editBlock.properties.replace.description, undefined);
  assert.match(observedPrompt, /AutonomousCodingContextPacket/);
  assert.match(observedPrompt, /export const add = \(a, b\) => a - b/);
  assert.match(observedPrompt, /machineCheckableGoalConditions/);
});

test("a later edit cannot regress a verification that an earlier transition settled green", () => {
  const territory = fixture();
  const tools = createAgentTools({
    root: territory,
    verifyCommand: "node --test calc.test.mjs",
    acceptanceCommand: "node --test calc.test.mjs",
    writablePaths: ["calc.mjs"],
  });
  const repaired = JSON.parse(tools.execute({
    action: "edit",
    args: { path: "calc.mjs", blocks: { search: "a - b", replace: "a + b" } },
  }));
  assert.equal(repaired.verification.passed, true);
  const regressed = JSON.parse(tools.execute({
    action: "edit",
    args: { path: "calc.mjs", blocks: { search: "a + b", replace: "a - b" } },
  }));
  assert.equal(regressed.rolledBack, true);
  assert.match(readFileSync(join(territory, "calc.mjs"), "utf8"), /a \+ b/u);
});

test("green verification and red acceptance contract the next edit to acceptance-named writable artifacts", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  writeFileSync(join(territory, "witness.txt"), "pending\n");
  const jobs = [];
  const result = await runMission({
    id: "urn:test:mission:acceptance-lane",
    objective: "Repair calculation and settle its declared acceptance witness.",
    territory,
    verifyCommand: "node --test calc.test.mjs",
    acceptanceCommand: "rg -q accepted witness.txt && node --test calc.test.mjs",
    testVectors: [additionAcceptanceVector],
    workType: "software-engineering",
    requiredCapabilities: ["software-engineering", "json-schema-output"],
    focusPaths: ["calc.mjs", "witness.txt"],
    writablePaths: ["calc.mjs", "witness.txt"],
    testVectors: [{ id: "acceptance-lane", given: ["broken source and pending witness"], when: "the source and witness settle", then: ["verification and acceptance pass"], forbidden: [] }],
  }, {
    dataRoot,
    dispatch: async ([job]) => {
      jobs.push(job);
      return [response(job, jobs.length === 1
        ? { action: "edit", args: { path: "calc.mjs", blocks: { search: "a - b", replace: "a + b" } } }
        : { action: "edit", args: { path: "witness.txt", blocks: { search: "pending", replace: "accepted" } } })];
    },
  });
  assert.equal(result.outcome.verified, true);
  const editAlternative = jobs[1].outputContract.schema.oneOf.find((alternative) => alternative.properties.action.const === "edit");
  assert.deepEqual(editAlternative.properties.args.oneOf.map((alternative) => alternative.properties.path.const), ["witness.txt"]);
});

test("an absent declared writable target is offered only as an exact create action", () => {
  const schema = softwareEditActionSchema(["test/deployment-serialization.test.mjs"], [{
    path: "test/deployment-serialization.test.mjs", exists: false, confined: true, byteLength: 0, text: "", truncated: false,
  }]);
  assert.deepEqual(schema.properties.action.enum, ["create"]);
  assert.equal(schema.oneOf.length, 1);
  assert.equal(schema.oneOf[0].properties.action.const, "create");
  const args = schema.oneOf[0].properties.args.oneOf[0];
  assert.equal(args.properties.path.const, "test/deployment-serialization.test.mjs");
  assert.equal(args.properties.content.type, "string");
  assert.equal(args.properties.blocks, undefined);
});

test("a software mission composes small current-source edit transitions until its acceptance is verified", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  writeFileSync(join(territory, "calc.mjs"), [
    "export const add = (a, b) => a - b;",
    'export const label = () => "old";',
    "",
  ].join("\n"));
  writeFileSync(join(territory, "calc.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add, label } from "./calc.mjs";',
    'test("adds", () => assert.equal(add(2, 3), 5));',
    'test("labels", () => assert.equal(label(), "new"));',
    "",
  ].join("\n"));
  const jobs = [];
  const dispatch = async (requested) => {
    const job = requested[0];
    jobs.push(job);
    const action = jobs.length === 1
      ? { action: "edit", args: { path: "calc.mjs", blocks: [
          { search: 'label = () => "old"', replace: 'label = () => "pending"' },
          { search: '"pending"', replace: '"new"' },
        ] }, reason: "compose two ordered small edits against evolving current bytes" }
      : { action: "edit", args: { path: "calc.mjs", blocks: { search: "a - b", replace: "a + b" } }, reason: "repair the remaining small admitted expression" };
    return [response(job, action)];
  };
  const result = await runMission({
    id: "urn:test:mission:small-sequence", objective: "Repair both declared calculation behaviors.", territory,
    verifyCommand: "node --test calc.test.mjs", acceptanceCommand: "node --test calc.test.mjs",
    workType: "software-engineering", requiredCapabilities: ["software-engineering", "json-schema-output"],
    focusPaths: ["calc.mjs", "calc.test.mjs"], writablePaths: ["calc.mjs"], readablePaths: [],
    testVectors: [{ id: "small-edits", given: ["the admitted calculation source"], when: "two exact source transitions are applied", then: ["both declared checks pass"], forbidden: [] }],
  }, { dispatch, dataRoot });

  assert.equal(result.outcome.verified, true);
  assert.equal(result.metrics.inferenceContacts, 2);
  assert.deepEqual(jobs.map((job) => job.id), ["urn:test:mission:small-sequence:1", "urn:test:mission:small-sequence:2"]);
  assert.match(jobs[1].messages[1].content, /label = \(\) => \\"new\\"/u);
  assert.doesNotMatch(jobs[1].messages[1].content, /pending/u);
  assert.equal(result.processNode.actions.length, 2);
  assert.equal(result.processNode.procurements.length, 2);
  assert.equal(result.processNode.attempts.length, 2);
});

test("a repeated deterministic transition stops the process node without an arbitrary contact limit", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  const jobs = [];
  const result = await runMission({
    id: "urn:test:mission:fixed-point", objective: "Read the admitted source until a deterministic fixed point is detected.", territory,
    verifyCommand: "node --test calc.test.mjs",
  }, { dispatch: async (requested) => {
    jobs.push(requested[0]);
    return [response(requested[0], { action: "test", args: {}, reason: "observe the declared verification without changing the process node" })];
  }, dataRoot });

  assert.equal(jobs.length, 2);
  assert.equal(result.processNode.status, "stopped");
  assert.equal(result.processNode.fixedPoint.type, "repeated-deterministic-transition");
  assert.equal(result.metrics.inferenceContacts, 2);
});

test("each needed contact records its provider-authored exact price without an integer cap", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  let contacts = 0;
  const dispatch = async (jobs) => {
    contacts += 1;
    return jobs.map((job) => ({ ...response(job, contacts === 1 ? {
      action: "edit",
      args: { path: "calc.mjs", blocks: { search: "a - b", replace: "a * b" } },
      reason: "one grounded but insufficient transition",
    } : {
      action: "edit",
      args: { path: "calc.mjs", blocks: { search: "a * b", replace: "a + b" } },
      reason: "the next market-priced transition satisfies the oracle",
    }),
      cost: {
        obligations: [{
          id: "resolution-credit", kind: "credit", asset: "urn:union:credit:relative-resolution-milliquanta-v1",
          amount: { numerator: contacts === 1 ? "31" : "10", denominator: "1" }, unit: "relative-resolution-milliquanta-v1", settlementCapability: "urn:union:settlement-capability:direct-witness-v1",
        }],
      },
    }));
  };
  const result = await runMission({
    id: "urn:test:mission:aggregate-consideration",
    objective: "Repair addition through provider-priced exact transitions.",
    territory,
    verifyCommand: "node --test calc.test.mjs",
    workType: "software-engineering",
    focusPaths: ["calc.mjs"],
    writablePaths: ["calc.mjs"],
    testVectors: [{ id: "priced-retry", given: ["one insufficient paid transition"], when: "the oracle remains red", then: ["the next contact returns to the market"], forbidden: ["integer price coercion"] }],
    requiredCapabilities: ["software-engineering", "json-schema-output"],
  }, { dispatch, dataRoot });
  assert.equal(contacts, 2);
  assert.equal(result.outcome.verified, true);
  assert.equal(result.metrics.inferenceContacts, 2);
  assert.deepEqual(result.metrics.expectedConsideration.map(({ amount }) => amount), [
    { numerator: "31", denominator: "1" },
    { numerator: "10", denominator: "1" },
  ]);
});

test("fixed-point identity observes full writable bytes beyond the capped prompt prefix", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  writeFileSync(join(territory, "large.txt"), `${"x".repeat(12_000)}A`);
  writeFileSync(join(territory, "toggle.mjs"), [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'const path = new URL("./large.txt", import.meta.url);',
    'const current = readFileSync(path, "utf8");',
    'writeFileSync(path, `${current.slice(0, -1)}${current.endsWith("A") ? "B" : "A"}`);',
    "",
  ].join("\n"));
  let contacts = 0;
  const result = await runMission({
    id: "urn:test:mission:full-byte-fixed-point", objective: "Observe a full-byte workspace cycle.", territory,
    verifyCommand: "node --test calc.test.mjs", writablePaths: ["large.txt"],
    commands: { toggle: { command: "node toggle.mjs" } },
  }, { dispatch: async (requested) => {
    contacts += 1;
    return [response(requested[0], { action: "command", args: { name: "toggle" }, reason: "advance the admitted deterministic workspace transition" })];
  }, dataRoot });

  assert.equal(contacts, 3);
  assert.equal(result.processNode.actions.length, 2);
  assert.equal(result.processNode.fixedPoint.type, "repeated-deterministic-transition");
});

test("an abort at action settlement retains the passing action evidence without verifying or integrating it", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data"), controller = new AbortController();
  const events = [];
  const result = await runMission({
    id: "urn:test:mission:abort-at-action-settlement", objective: "Repair addition unless the external lifecycle is stopped.", territory,
    verifyCommand: "node --test calc.test.mjs", testVectors: [additionAcceptanceVector], writablePaths: ["calc.mjs"],
  }, {
    dispatch: async (requested) => [response(requested[0], {
      action: "edit",
      args: { path: "calc.mjs", blocks: { search: "a - b", replace: "a + b" } },
      reason: "perform the exact verification-passing source transition",
    })],
    dataRoot,
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "process-node-action-settled") controller.abort();
    },
  });

  assert.ok(events.some((event) => event.type === "process-node-action-settled"));
  assert.equal(result.processNode.status, "stopped");
  assert.equal(result.processNode.refusal.type, "aborted");
  assert.equal(result.processNode.actions.length, 1);
  assert.equal(result.processNode.observations.length, 1);
  assert.match(result.processNode.observations[0], /"verification":\{"passed":true/);
  assert.equal(result.outcome.verified, false);
  assert.equal(result.outcome.integrated, false);
  assert.equal(result.outcome.proposal, null);
});

test("an abort after provider contact preserves returned attempt and procurement evidence before stopping", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data"), controller = new AbortController();
  let contacts = 0;
  const result = await runMission({
    id: "urn:test:mission:abort-after-contact", objective: "Stop after recording the contacted provider.", territory,
    verifyCommand: "node --test calc.test.mjs", testVectors: [additionAcceptanceVector],
  }, { dispatch: async (requested) => {
    contacts += 1;
    controller.abort();
    return [{
      ...response(requested[0], { action: "test", args: {}, reason: "return one contacted-provider observation" }),
      provider: "urn:provider:contacted-before-abort",
      procurement: { receipt: "ni:///sha-256;market-receipt-before-abort" },
    }];
  }, dataRoot, signal: controller.signal });

  assert.equal(contacts, 1);
  assert.equal(result.processNode.status, "stopped");
  assert.equal(result.processNode.refusal.type, "aborted");
  assert.equal(result.metrics.inferenceContacts, 1);
  assert.equal(result.processNode.attempts.length, 1);
  assert.equal(result.processNode.procurements.length, 1);
  assert.equal(result.processNode.procurements[0].receipt, "ni:///sha-256;market-receipt-before-abort");
  assert.equal(result.processNode.procurements[0].providerNativeReceipt, null);
  assert.match(result.processNode.observations[0], /"contacted":true/);
  assert.match(result.processNode.observations[0], /"attemptsObserved":1/);
});

test("a dispatch AbortError records the contacted unknown-receipt boundary before stopping", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data"), controller = new AbortController();
  const result = await runMission({
    id: "urn:test:mission:dispatch-abort", objective: "Stop when the contacted dispatch boundary aborts.", territory,
    verifyCommand: "node --test calc.test.mjs", testVectors: [additionAcceptanceVector],
  }, { dispatch: async () => {
    controller.abort();
    const error = new Error("provider contact aborted");
    error.name = "AbortError";
    throw error;
  }, dataRoot, signal: controller.signal });

  assert.equal(result.processNode.status, "stopped");
  assert.equal(result.processNode.procurements.length, 1);
  assert.equal(result.processNode.procurements[0].providerNativeReceipt, null);
  assert.equal(result.processNode.procurements[0].receipt, null);
  assert.equal(result.processNode.attempts.length, 0);
  assert.match(result.processNode.observations[0], /"recordReceived":false/);
});

test("mission readablePaths are mechanically projected into the isolated process-node toolset", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  const dispatch = async (jobs) => jobs.map((job) => response(job, {
    action: "read",
    args: { path: "calc.mjs" },
    reason: "attempt to inspect a path outside the admitted read scope",
  }));
  const result = await runMission({
    id: "urn:test:mission:readable-projection",
    objective: "Prove that process-node reads are confined to the declared test file.",
    territory,
    verifyCommand: "node --test calc.test.mjs",
    testVectors: [additionAcceptanceVector],
    readablePaths: ["calc.test.mjs"],
  }, { dispatch, dataRoot });

  assert.match(result.processNode.observations[0], /outside declared readable paths/);
  assert.doesNotMatch(result.processNode.observations[0], /export const add/);
});

test("software engineering is not dispatched with a deficient context packet", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  let dispatched = false;
  await assert.rejects(runMission({
    id: "urn:test:mission:deficient-context",
    objective: "Make an unspecified code change without any admitted focus evidence.",
    territory,
    verifyCommand: "node --test",
    workType: "software-engineering",
    requiredCapabilities: ["software-engineering", "json-schema-output"],
    focusPaths: [],
  }, { dispatch: async () => { dispatched = true; return []; }, dataRoot }), /explicit nonempty writable lane/);
  assert.equal(dispatched, false);
});

test("a fabrication mission derives must-create context from its writable lane", async () => {
  const territory = mkdtempSync(join(tmpdir(), "union-create-test-"));
  const dataRoot = join(territory, "free-compute-data");
  const result = await runMission({
    id: "urn:test:mission:create-from-writable-lane",
    objective: "Create the declared capability implementation.",
    territory,
    verifyCommand: "node --test test/capability.test.mjs",
    acceptanceCommand: "node --test test/capability.test.mjs",
    workType: "software-engineering",
    requiredCapabilities: ["software-engineering"],
    writablePaths: ["src/capability.mjs", "test/capability.test.mjs"],
    readablePaths: [],
    testVectors: [{
      id: "declared-operation",
      given: ["an admitted input"],
      when: "the capability is invoked",
      then: ["one typed result is returned"],
      forbidden: ["undeclared mutation"],
    }],
  }, {
    dataRoot,
    dispatch: async (jobs) => jobs.map((job) => ({ id: job.id, refusal: { type: "fixture-stop" }, attempts: [] })),
  });

  assert.equal(result.contextPacket.quality.selfContainment, true);
  assert.deepEqual(result.contextPacket.lane.focusPaths, ["src/capability.mjs", "test/capability.test.mjs"]);
  assert.deepEqual(result.contextPacket.targetArtifacts, [
    { path: "src/capability.mjs", status: "must-create" },
    { path: "test/capability.test.mjs", status: "must-create" },
  ]);
});

test("missing executable acceptance examples become planner observations instead of a dispatch ceiling", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  let dispatched = false;
  const result = await runMission({
    id: "urn:test:mission:missing-test-vectors",
    objective: "Repair the admitted calculation source with complete focus evidence.",
    territory,
    verifyCommand: "node --test calc.test.mjs",
    acceptanceCommand: "node --test calc.test.mjs",
    workType: "software-engineering",
    requiredCapabilities: ["software-engineering", "json-schema-output"],
    focusPaths: ["calc.mjs", "calc.test.mjs"],
    writablePaths: ["calc.mjs", "calc.test.mjs"],
    readablePaths: [],
  }, {
    dispatch: async () => { dispatched = true; return []; },
    dataRoot,
    appendTrajectory: async (trajectory) => trajectory,
    recallTrajectories: async () => [],
  });
  assert.equal(dispatched, true);
  assert.equal(result.contextPacket.quality.executableAcceptanceExamples, false);
  assert.equal(result.outcome.continuationRequired, true);
  assert.equal(result.outcome.classification, "continuation-required");
  assert.equal(result.metrics.inferenceContacts, 1);
  assert.match(result.processNode.observations[0], /ContextQualityObservation/);
  assert.match(result.processNode.observations[0], /executableAcceptanceExamples/);
});

test("one refused provider contact terminates the process node without replacement", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  let dispatchCalls = 0;
  const dispatch = async (jobs) => {
    dispatchCalls += 1;
    return jobs.map((job) => ({ id: job.id, refusal: { type: "no-feasible-endpoint", market: [{ actor: "urn:ame:bounded-provider", reason: "demand-exceeds-provider-bound" }], settlementResidues: [] }, attempts: [] }));
  };
  const result = await runMission({
    id: "urn:test:mission:circuit-breaker",
    objective: "Repair the add function so the declared test passes.",
    territory,
    verifyCommand: "node --test calc.test.mjs",
    testVectors: [additionAcceptanceVector],
  }, { dispatch, dataRoot });

  assert.equal(result.outcome.verified, false);
  assert.equal(result.outcome.classification, "unresolved");
  assert.equal(result.metrics.verifiedCandidates, 0);
  assert.equal(dispatchCalls, 1);
  assert.equal(result.metrics.inferenceContacts, 1);
  assert.equal(result.processNode.status, "refused");
  assert.equal(result.processNode.refusal.type, "no-feasible-endpoint");
  assert.equal(result.processNode.refusal.market[0].reason, "demand-exceeds-provider-bound");
});

test("one protocol-invalid tool action terminates the process node without another inference contact", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  let dispatchCalls = 0;
  const dispatch = async (jobs) => {
    dispatchCalls += 1;
    return jobs.map((job) => response(job, {
      action: "edit",
      args: { path: "calc.mjs", blocks: { search: "a - b", replace: "a - b" } },
      reason: "provider emitted a schema-valid but semantically empty edit",
    }));
  };
  const events = [];
  const result = await runMission({
    id: "urn:test:mission:invalid-action-circuit-breaker",
    objective: "Repair the add function so the declared test passes.",
    territory,
    verifyCommand: "node --test calc.test.mjs",
    testVectors: [additionAcceptanceVector],
    writablePaths: ["calc.mjs"],
  }, { dispatch, dataRoot, onEvent: (event) => events.push(event) });

  assert.equal(dispatchCalls, 1);
  assert.equal(result.metrics.inferenceContacts, 1);
  assert.equal(result.processNode.status, "refused");
  assert.equal(result.processNode.refusal.type, "invalid-action-candidate");
  assert.match(result.processNode.refusal.reason, /no differential information/);
  assert.ok(events.some((event) => event.type === "process-node-action-refused"));
});

test("the process node does not return to the market after its selected supplier refuses", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  const lots = [];
  const dispatch = async (jobs) => {
    lots.push(jobs[0]);
    if (lots.length === 1) return [{ id: jobs[0].id, provider: "urn:ame:refusing-provider", refusal: { type: "provider-refusal" }, attempts: [] }];
    return [response(jobs[0], {
      action: "edit",
      args: { path: "calc.mjs", blocks: { search: "a - b", replace: "a + b" } },
      reason: "repair through the cheapest feasible fallback route",
    })];
  };
  const result = await runMission({
    id: "urn:test:mission:affinity-fallback",
    objective: "Repair addition even when the initially sharded supplier refuses.",
    territory,
    verifyCommand: "node --test calc.test.mjs",
    testVectors: [additionAcceptanceVector],
  }, { dispatch, dataRoot });

  assert.equal(lots.length, 1);
  assert.ok(lots.every((job) => job.preferEndpoints === undefined));
  assert.equal(result.outcome.verified, false);
});

test("a first refused contact is terminal even when later responses were available", async () => {
  const territory = fixture(), dataRoot = join(territory, "free-compute-data");
  let wave = 0;
  const dispatch = async (jobs) => {
    wave += 1;
    if (wave === 1) return jobs.map((job) => ({ id: job.id, refusal: { type: "no-feasible-endpoint" }, attempts: [] }));
    if (wave === 2) return jobs.map((job) => response(job, { action: "read", args: { path: "calc.mjs" }, reason: "inspect before editing" }));
    if (wave === 3) return jobs.map((job) => ({ id: job.id, refusal: { type: "no-feasible-endpoint" }, attempts: [] }));
    return jobs.map((job) => response(job, {
      action: "edit",
      args: { path: "calc.mjs", blocks: "<<<<<<< SEARCH\nexport const add = (a, b) => a - b;\n=======\nexport const add = (a, b) => a + b;\n>>>>>>> REPLACE" },
      reason: "fix addition",
    }));
  };
  const result = await runMission({
    id: "urn:test:mission:refusal-reset",
    objective: "Repair the add function so the declared test passes.",
    territory,
    verifyCommand: "node --test calc.test.mjs",
    testVectors: [additionAcceptanceVector],
  }, { dispatch, dataRoot });

  assert.equal(result.outcome.verified, false);
  assert.equal(result.metrics.inferenceContacts, 1);
  assert.equal(wave, 1);
  assert.equal(result.processNode.status, "refused");
});

test("the next mission prompt carries exact bounded assay evidence learned from prior residue", () => {
  const packet = {
    identity: { missionId: "urn:test:compact" }, objective: "repair exact source", machineChecks: { verifyCommand: "node --test" },
    acceptanceTestVectors: [{ id: "exact-vector", given: ["x"], when: "repair", then: ["passes"] }], acceptanceAuthority: { protected: true },
    lane: { focusPaths: ["src/a.mjs"], writablePaths: ["src/a.mjs"] }, targetArtifacts: [], evidenceArtifacts: [{ path: "src/a.mjs", content: "export const exact = false;" }], omittedArtifacts: [], priorVerifiedKnowledge: [],
    priorResidueKnowledge: [
      { type: "SoftwareTrajectoryResidueKnowledge", dominantRefusal: "candidate-refused-by-schema-assay", occurrences: 2, providers: ["urn:ame:prior"], schemaAssays: ["ni:///sha-256;assay-old", "ni:///sha-256;assay"], problems: ["$/args:required:must have required property 'blocks'", "$:required:must have required property 'reason'"], latestSchemaAssay: "ni:///sha-256;assay", latestProblems: ["$:required:must have required property 'reason'"], latestWitness: "urn:trajectory:latest", witnesses: ["urn:trajectory:prior", "urn:trajectory:latest"], strategy: "induce-deterministic-validator-or-translator", modelEscalationAllowed: false, capabilityFormationRequired: true, nextAct: "advertise-capability-formation-demand" },
      { type: "SoftwareTrajectoryResidueKnowledge", dominantRefusal: "invalid-action-candidate", occurrences: 1, latestReasons: ["edit search is not present in the evolving current source"], latestWitness: "urn:trajectory:invalid-action" },
    ],
    constraints: ["smallest change"], firstMoves: ["edit exact source"],
    repositoryMap: { files: Array.from({ length: 1000 }, (_, index) => `irrelevant-${index}.mjs`) },
    outputContract: { actionSchema: { hostOnlySentinel: "do-not-project" } }, packetQuality: { hostOnly: true }, resourceAccount: { hostOnly: true }, digest: "sha256:host-retained",
  };
  const prompt = processNodePrompt({ observations: [] }, packet, {
    type: "object",
    required: ["action", "args", "reason"],
    properties: {
      action: { const: "edit" },
      args: { type: "object", required: ["path", "blocks"] },
      reason: { type: "string" },
    },
    additionalProperties: false,
  });
  assert.match(prompt, /export const exact = false/u);
  assert.match(prompt, /exact-vector/u);
  assert.match(prompt, /candidate-refused-by-schema-assay/u);
  assert.match(prompt, /required property 'blocks'/u);
  assert.match(prompt, /ni:\/\/\/sha-256;assay/u);
  assert.match(prompt, /LEARNED OUTPUT CORRECTIONS/u);
  assert.match(prompt, /"requiredRootFields":\["action","args","reason"\]/u);
  assert.match(prompt, /Prior assay problems describe rejected earlier outputs; they are not the current task/u);
  assert.match(prompt, /"priorAssayProblems":\["\$:required:must have required property 'reason'"\]/u);
  assert.match(prompt, /LEARNED ACTION CORRECTIONS/u);
  assert.match(prompt, /edit search is not present in the evolving current source/u);
  assert.match(prompt, /Objective, constraint, routing, rationale, residue, observation, and metadata prose are never source bytes/u);
  assert.doesNotMatch(prompt, /irrelevant-999/u);
  assert.doesNotMatch(prompt, /do-not-project/u);
  assert.ok(Buffer.byteLength(prompt) < 4096);
});
