import { randomUUID } from "node:crypto";
import { Message, Role } from "@a2a-js/sdk";
import { a2aResultParts, resumeRmnTask, sendRmnTask } from "@emsenn/a2a-rmn-task-client-service";
import { extractRmnPart, rmnPart } from "@emsenn/a2a-rmn-part-service";
import { semanticId } from "@emsenn/rmn-semantic-conformance";
import { relationalRwilDocument } from "@emsenn/rwil-rdf-services/client";
import { ACTOR, operationBytes, operationFromBytes } from "./a2a-executor.mjs";
import { induceVerifiedMissionProposal } from "./customer-induction.mjs";

function rmnId(value) { return semanticId(relationalRwilDocument(value)); }
function record(body) { return Object.freeze({ id: rmnId(body), ...body }); }
function agentUrl(value) {
  const url = value ?? process.env.SOFTWARE_MISSION_EXECUTION_AGENT_CARD_URL;
  if (typeof url !== "string" || !url) throw new Error("SOFTWARE_MISSION_EXECUTION_AGENT_CARD_URL is required");
  return url;
}
const responseParts = a2aResultParts;

export async function invokeSoftwareMissionOperation(request, { agentCardUrl, send = sendRmnTask, resume = resumeRmnTask, resumeTaskId, onTaskObservation, signal } = {}) {
  const message = Message.toJSON({
    messageId: randomUUID(), contextId: "", taskId: "", role: Role.ROLE_USER,
    parts: [rmnPart(operationBytes(request))], metadata: {}, extensions: [], referenceTaskIds: [],
  });
  const address = agentUrl(agentCardUrl);
  const transport = resumeTaskId
    ? await resume({ agentUrl: address, taskId: resumeTaskId, inputNi: request.id, requireSignature: true, onTaskObservation, signal })
    : await send({ agentUrl: address, message, requireSignature: true, onTaskObservation, signal });
  const output = extractRmnPart(responseParts(transport.result));
  const response = operationFromBytes(output.bytes);
  if (response?.provider !== ACTOR || response.request !== request.id || typeof response.id !== "string") throw new Error("software mission provider returned a foreign operation result");
  return Object.freeze({ response, transport: { inputNi: transport.inputNi, outputNi: transport.outputNi, agentCard: transport.agentCard, authentication: { agentCardSignatureVerified: true, required: true } } });
}

export async function executeSoftwareMission(mission, options = {}) {
  const request = record({ type: "SoftwareMissionExecutionRequest", provider: ACTOR, mission });
  const { response, transport } = await invokeSoftwareMissionOperation(request, options);
  if (response.type !== "SoftwareMissionExecutionResult" || response.mission !== mission.id) throw new Error("software mission provider returned the wrong result type or mission");
  const customerInduction = induceVerifiedMissionProposal(mission, response.result);
  const outcome = customerInduction
    ? {
        ...response.result.outcome,
        integrated: true,
        inductionRequired: false,
        classification: "integrated",
        integration: { integrated: true, receiver: "software-mission-customer-client" },
      }
    : response.result.outcome;
  return Object.freeze({
    ...response.result,
    outcome,
    ...(customerInduction ? { providerOutcome: response.result.outcome, customerInduction } : {}),
    executionProvider: ACTOR,
    executionReceipt: transport,
  });
}
