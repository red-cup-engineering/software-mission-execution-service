import { inferenceBatchRequest, requestInferenceWorkBatch } from "@emsenn/inference-work-lot-service/client";

const ACTOR = "urn:ame:software-mission-execution-service";
const PROFILE = Object.freeze({ customer: ACTOR, purpose: "Produce one bounded software-mission action proposal; do not mutate customer territory or claim customer acceptance.", desiredUse: "Return one advisory action for isolated execution against the customer-declared verification and acceptance.", workLotPrefix: "software-mission" });
export const fabricDefaults = Object.freeze({ customer: ACTOR, market: "urn:ame:inference-work-lot-service", selectionOwner: "urn:ame:inference-work-lot-service", acceptanceOwner: ACTOR, carrier: ["signed A2A 1.0 Agent Card", "canonical RMN/CBOR", "RWIL/RDF"] });
export const inferenceWorkRequest = (job) => inferenceBatchRequest(job, PROFILE);
function marketUrl(value) { const source = value ?? process.env.INFERENCE_WORK_LOT_AGENT_CARD_URL; if (typeof source !== "string" || !/^https?:\/\//u.test(source)) throw new Error("INFERENCE_WORK_LOT_AGENT_CARD_URL is required"); return source; }
export async function dispatchBatch(jobs, options = {}) {
  if (options.signal?.aborted) { const error = new Error(typeof options.signal.reason === "string" ? options.signal.reason : "inference procurement aborted"); error.name = "AbortError"; throw error; }
  return requestInferenceWorkBatch(jobs, {
    ...options,
    agentUrl: marketUrl(options.marketAgentUrl),
    ...PROFILE,
  });
}
