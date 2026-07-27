import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { startRwilProviderProcess } from "@lenticule-science/rwil-rdf-projection-service/test-provider";
import { runMissionPipeline } from "../src/mission-pipeline.mjs";

let rwil;
const settlementCaip2 = "eip155:31337";
test.before(async () => { rwil = await startRwilProviderProcess(); });
test.after(async () => { await rwil.close(); });

function result(verified, label) {
  return {
    outcome: {
      verified,
      integrated: false,
      classification: verified ? "awaiting-receiver-induction" : "unresolved",
      summary: label,
      proposal: verified ? { type: "SoftwareMissionChangeProposal", proposalOnly: true, customerMutation: false } : null,
    },
    metrics: { inferenceAttempts: 1, usefulCompletions: verified ? 1 : 0, directInteractiveModelCalls: 0 },
    processNode: { id: "process-node", status: verified ? "verified" : "refused", observations: [label] },
  };
}

test("one A2A request performs one knowledge pulse and leaves failure in enterprise memory", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "union-route-data-")), calls = [];
  const mission = {
    id: "urn:test:knowledge-pulse:first",
    objective: "add a deterministic regression for the runtime",
    taskClass: "runtime-regression-authoring",
    territory: dataRoot,
    verifyCommand: "true",
    supplierExclusions: ["urn:ame:conflicted-provider"],
  };
  const runMission = async (input) => { calls.push(input); return result(false, "one bounded provider contact could not resolve"); };
  const settled = await runMissionPipeline(mission, {
    runMission,
    dataRoot,
    rwilAgentUrl: rwil.agentCardUrl,
    settlementCaip2,
  });

  assert.equal(settled.outcome.verified, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].supplierExclusions, ["urn:ame:conflicted-provider"]);
  assert.equal(settled.phases.length, 1);
  assert.equal(settled.phases[0].kind, "enterprise-knowledge-pulse");
  assert.equal(settled.route.routePolicy, "enterprise-memory-pulse-only");
  assert.equal(settled.route.nextActCarrier, "software-trajectory-memory-service");
  assert.deepEqual(settled.route.continuation, { state: "durable-demand-open", nextAct: "return-to-capability-market" });
});

test("legacy synchronous routing profiles do not control market continuation", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "union-route-data-"));
  const settled = await runMissionPipeline({
    id: "urn:test:extended-without-rationale", objective: "multi-file assay", territory: dataRoot,
    verifyCommand: "true", routingProfile: "extended",
  }, { dataRoot, rwilAgentUrl: rwil.agentCardUrl, settlementCaip2, runMission: async () => result(true, "market settled") });
  assert.deepEqual(settled.route.continuation, { state: "awaiting-customer-induction" });
});

test("rejects customer token ceilings so provider offers determine capacity", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "union-route-data-"));
  const calls = [];
  await assert.rejects(runMissionPipeline({
    id: "urn:test:provider-priced-token-demand", objective: "provider-priced token demand", territory: dataRoot,
    verifyCommand: "true", maxTokens: 8193,
  }, {
    dataRoot,
    rwilAgentUrl: rwil.agentCardUrl,
    settlementCaip2,
    runMission: async (mission) => { calls.push(mission); return result(true, "provider admitted the requested lot"); },
  }), /maxTokens is retired/u);
  assert.equal(calls.length, 0);
});

test("refuses a non-positive token quantity before provider-market selection", async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), "union-route-data-"));
  let calls = 0;
  await assert.rejects(runMissionPipeline({
    id: "urn:test:invalid-token-quantity", objective: "invalid token quantity", territory: dataRoot,
    verifyCommand: "true", maxTokens: 0,
  }, {
    dataRoot,
    rwilAgentUrl: rwil.agentCardUrl,
    settlementCaip2,
    runMission: async () => { calls += 1; return result(true, "must not run"); },
  }), /maxTokens is retired/u);
  assert.equal(calls, 0);
});
