import assert from "node:assert/strict";
import test from "node:test";
import { dispatchBatch, fabricDefaults, inferenceWorkRequest } from "../src/market-client.mjs";

const job = {
  id: "urn:test:fabric:bounded",
  workType: "software-engineering",
  requiredCapabilities: ["software-engineering", "json-schema-output"],
  difficulty: 0.4,
  maxTokens: 500,
  messages: [{ role: "user", content: "return one bounded candidate" }],
  outputContract: { format: "json", mode: "json_schema", schema: { type: "object" } },
};

test("typed procurement dispatch stops before any market act when its circuit is aborted", async () => {
  const controller = new AbortController();
  controller.abort("customer withdrew the bounded grant");
  await assert.rejects(dispatchBatch([job], { signal: controller.signal }), (error) => error.name === "AbortError" && /withdrew/u.test(error.message));
});

test("the customer hires one sovereign inference market and retains acceptance", () => {
  assert.equal(fabricDefaults.customer, "urn:ame:software-mission-execution-service");
  assert.equal(fabricDefaults.market, "urn:ame:inference-work-lot-service");
  assert.equal(fabricDefaults.selectionOwner, "urn:ame:inference-work-lot-service");
  assert.equal(fabricDefaults.acceptanceOwner, fabricDefaults.customer);
  assert.deepEqual(fabricDefaults.carrier, ["signed A2A 1.0 Agent Card", "canonical RMN/CBOR", "witness-journal RDF"]);
});

test("one job becomes one context-complete public market request without provider selection", () => {
  const request = inferenceWorkRequest({ ...job, excludeProviders: ["urn:ame:prior-author"] });
  assert.equal(request.workLotId, job.id);
  assert.deepEqual(request.excludeProviders, ["urn:ame:prior-author"]);
  assert.equal(Object.hasOwn(request, "agentCards"), false);
  assert.equal(JSON.parse(request.context).messages[0].content, "return one bounded candidate");
});

test("an explicitly rationalized extended mission reaches the market without provider selection", () => {
  const request = inferenceWorkRequest({ ...job, routingProfile: "extended",
    extendedRoutingRationale: "The exact multi-file node assay cannot fit the bounded provider packet." });
  assert.equal(request.routingProfile, "extended");
  assert.match(request.extendedRoutingRationale, /multi-file node assay/u);
  assert.equal(Object.hasOwn(request, "agentCards"), false);
});

test("a market candidate preserves economic and seam evidence without becoming customer acceptance", async () => {
  let calls = 0;
  const contract = async ({ request }) => {
    calls += 1;
    assert.equal(request.workLotId, job.id);
    return {
      provider: { account: "eip155:31337:0x1111111111111111111111111111111111111111" },
      resultNi: "ni:///sha-256;result",
      exchange: { inputNi: "ni:///sha-256;input" },
      result: {
        outcome: "candidate-pending-customer-acceptance", provider: "urn:ame:selected-provider", model: "model",
        consideration: { amount: 27, unit: "relative-resolution-milliquanta-v1" }, candidate: { candidate: true },
        selectionRule: "least-admissible-consideration", rankedFeasibleOffers: [], considerationDisposition: "credit-issued", integrationAccepted: false,
        evidence: { selectedOffer: "ni:///sha-256;offer", providerProposal: "ni:///sha-256;proposal", settlement: "ni:///sha-256;settlement", schemaAssay: "ni:///sha-256;assay" },
      },
    };
  };
  const [record] = await dispatchBatch([job], { marketAgentUrl: "https://market.example/.well-known/agent-card.json", contract });
  assert.equal(calls, 1);
  assert.equal(record.provider, "urn:ame:selected-provider");
  assert.equal(record.text, '{"candidate":true}');
  assert.deepEqual(record.verification, { schemaAssay: "ni:///sha-256;assay", schemaAccepted: true, customerUsefulnessAccepted: false, providerSelfAttestation: false });
  assert.equal(record.procurement.market, "eip155:31337:0x1111111111111111111111111111111111111111");
  assert.equal(record.procurement.considerationDisposition, "credit-issued");
});

test("a schema-assay refusal preserves bounded learning evidence for its customer", async () => {
  let calls = 0;
  const contract = async () => ({
    provider: { account: "eip155:31337:0x1111111111111111111111111111111111111111" }, resultNi: "ni:///sha-256;result", exchange: { inputNi: "ni:///sha-256;input" },
    result: {
      outcome: "candidate-refused-by-schema-assay",
      provider: "urn:ame:selected",
      problems: ["$/args:required:must have required property 'blocks'"],
      schemaAssay: "ni:///sha-256;assay",
      considerationClose: "ni:///sha-256;close",
      considerationDisposition: "credit-issued",
      integrationAccepted: false,
    },
  });
  const [record] = await dispatchBatch([job], { marketAgentUrl: "https://market.example/.well-known/agent-card.json", contract: async (input) => { calls += 1; return contract(input); } });
  assert.equal(calls, 1);
  assert.equal(record.refusal.type, "candidate-refused-by-schema-assay");
  assert.equal(record.refusal.provider, "urn:ame:selected");
  assert.deepEqual(record.refusal.problems, ["$/args:required:must have required property 'blocks'"]);
  assert.equal(record.refusal.schemaAssay, "ni:///sha-256;assay");
  assert.equal(record.refusal.considerationClose, "ni:///sha-256;close");
  assert.equal(record.refusal.considerationDisposition, "credit-issued");
});
