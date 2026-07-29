import assert from "node:assert/strict";
import test from "node:test";
import { induceVerifiedMissionProposal } from "../src/customer-induction.mjs";

const mission = { id: "ni:///sha-256;mission", territory: "ni:///sha-256;territory", writablePaths: ["src"], verifyCommand: "npm test" };
const result = { semanticId: "ni:///sha-256;result", outcome: { candidateVerified: true, proposal: { type: "SoftwareMissionChangeProposal", proposalOnly: true, customerMutation: false, changes: [{ path: "src/fix.mjs", beforeDigest: "sha256:before", afterDigest: "sha256:after", afterBytesBase64: "eA==" }] } } };

test("verified customer induction is an inert manifest", () => {
  const manifest = induceVerifiedMissionProposal(mission, result);
  assert.equal(manifest.type, "SoftwareMissionCustomerInductionManifest");
  assert.equal(manifest.disposition, "proposal-awaiting-js-mark-admission");
  assert.equal(manifest.customerMutation, false);
  assert.deepEqual(manifest.proposal, result.outcome.proposal);
});

test("a manifest cannot escape its explicitly purchased writable lane", () => {
  assert.throws(() => induceVerifiedMissionProposal(mission, { ...result, outcome: { ...result.outcome, proposal: { ...result.outcome.proposal, changes: [{ ...result.outcome.proposal.changes[0], path: "package.json" }] } } }), /outside the customer writable lane/u);
});
