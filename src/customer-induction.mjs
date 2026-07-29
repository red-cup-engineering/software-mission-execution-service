// This cell is intentionally host-neutral.  A supplier can prove and propose
// a transition; only the JS Mark admission boundary may inspect a filesystem,
// check its preimages, and perform the transition.
import { semanticId } from "@red-cup-engineering/rmn-semantic-conformance";
import { relationalRwilDocument } from "@lenticule-science/rwil-rdf-projection-service/client";

const rmnId = (value) => semanticId(relationalRwilDocument(value));
const record = (body) => Object.freeze({ id: rmnId(body), ...body });

function verifiedProposal(mission, result) {
  if (mission?.induceVerifiedChanges === false || result?.outcome?.candidateVerified !== true) return null;
  const proposal = result.outcome.proposal;
  if (proposal?.type !== "SoftwareMissionChangeProposal" || proposal.proposalOnly !== true || proposal.customerMutation !== false || !Array.isArray(proposal.changes) || proposal.changes.length === 0) throw new Error("verified mission result lacks one proposal-only change set");
  if (!Array.isArray(mission.writablePaths) || mission.writablePaths.length === 0) throw new Error("customer induction requires an explicit writable lane");
  const seen = new Set();
  for (const change of proposal.changes) {
    if (typeof change?.path !== "string" || !change.path || change.path.startsWith("/") || change.path.split("/").includes("..") || seen.has(change.path)) throw new Error(`invalid proposal path: ${change?.path}`);
    seen.add(change.path);
    if (!mission.writablePaths.some((lane) => change.path === lane || change.path.startsWith(`${lane}/`))) throw new Error(`proposal path is outside the customer writable lane: ${change.path}`);
    if (typeof change.beforeDigest !== "string" || typeof change.afterDigest !== "string" || typeof change.afterBytesBase64 !== "string") throw new Error(`proposal change lacks canonical delta evidence: ${change.path}`);
  }
  return proposal;
}

/** Produce the sole input to host admission.  This does not inspect or mutate
 * `territory`; that reference is opaque until the JS Mark resolves it. */
export function induceVerifiedMissionProposal(mission, result) {
  const proposal = verifiedProposal(mission, result); if (proposal === null) return null;
  return record({ type: "SoftwareMissionCustomerInductionManifest", providerProposal: result.semanticId ?? null, mission: mission.id ?? null, territory: mission.territory, writablePaths: [...mission.writablePaths], verifyCommand: mission.verifyCommand, acceptanceCommand: mission.acceptanceCommand ?? mission.verifyCommand, proposal, disposition: "proposal-awaiting-js-mark-admission", customerMutation: false });
}
