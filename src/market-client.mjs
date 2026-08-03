import { EMPTY_WITNESS_ROOT, identifyJsonSemanticContent } from "@red-cup-engineering/semantic-content-identify-service";

const ACTOR = "urn:ame:software-mission-execution-service";
const PROFILE = Object.freeze({
  customer: ACTOR,
  purpose: "Produce the next software-mission transition without mutating customer territory or claiming customer acceptance.",
  desiredUse: "Return one advisory transition for isolated receiver verification.",
});
export const fabricDefaults = Object.freeze({
  customer: ACTOR,
  market: "urn:ame:inference-work-lot-service",
  selectionOwner: "urn:ame:inference-work-lot-service",
  acceptanceOwner: ACTOR,
  carrier: ["semantic-content", "semantic-record-journal"],
});

export function inferenceWorkRequest(job) {
  if (!job || typeof job !== "object" || typeof job.id !== "string" || job.id === "") throw new Error("inference job requires one stable id");
  const body = {
    type: "SoftwareMissionInferenceWorkLot",
    objective: job.objective ?? [...(job.messages ?? [])].reverse().find(({ role }) => role === "user")?.content ?? `Complete ${job.id}`,
    contextPacket: job.contextPacket,
    desiredUse: PROFILE.desiredUse,
    workType: job.workType ?? "inquiry",
    taskClass: job.taskClass ?? job.workType ?? "inquiry",
    requiredCapabilities: job.requiredCapabilities ?? [],
    outputContract: job.outputContract ?? null,
    excludeProviders: job.excludeProviders ?? [],
    considerationPolicy: job.considerationPolicy,
    customer: ACTOR,
  };
  const id = identifyJsonSemanticContent({ objectKind: "software-mission.inference-work-lot", value: body, witnessRoot: EMPTY_WITNESS_ROOT }).id;
  return Object.freeze({ id, ...body });
}

export async function dispatchBatch(jobs, { procureInferenceWorkBatch, signal } = {}) {
  if (signal?.aborted) { const error = new Error(typeof signal.reason === "string" ? signal.reason : "inference procurement aborted"); error.name = "AbortError"; throw error; }
  if (!Array.isArray(jobs) || jobs.length === 0) return [];
  if (typeof procureInferenceWorkBatch !== "function") return jobs.map((job) => ({
    id: job.id,
    attempts: [],
    refusal: { type: "inference-procurement-capability-unbound", reason: "receiver did not bind an inference-work procurement capability" },
    procurement: { frontierInferenceCalls: 0 },
  }));
  return procureInferenceWorkBatch(jobs.map(inferenceWorkRequest), { signal, customer: ACTOR });
}
