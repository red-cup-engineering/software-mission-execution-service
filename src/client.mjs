import { randomUUID } from "node:crypto";
import { Message, Role } from "@a2a-js/sdk";
import { a2aResultParts, resumeRmnTask, sendRmnTask, submitRmnTask } from "@red-cup-engineering/a2a-rmn-task-client-service";
import { extractRmnPart, rmnPart } from "@red-cup-engineering/a2a-rmn-part-service";
import { semanticId } from "@red-cup-engineering/rmn-semantic-conformance";
import { relationalRwilDocument } from "@lenticule-science/rwil-rdf-projection-service/client";
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

function missionRequest(mission, invocation) {
  return record({
    type: "SoftwareMissionExecutionRequest",
    provider: ACTOR,
    mission,
    ...(typeof invocation === "string" && invocation !== "" ? { invocation } : {}),
  });
}

function requestMessage(request) {
  return Message.toJSON({
    messageId: randomUUID(), contextId: "", taskId: "", role: Role.ROLE_USER,
    parts: [rmnPart(operationBytes(request))], metadata: {}, extensions: [], referenceTaskIds: [],
  });
}

export async function submitSoftwareMission(mission, {
  agentCardUrl,
  submit = submitRmnTask,
  onTaskObservation,
  signal,
  callbackUrl,
  callbackToken,
  invocation,
} = {}) {
  const request = missionRequest(mission, invocation);
  const submission = await submit({
    agentUrl: agentUrl(agentCardUrl),
    message: requestMessage(request),
    requireSignature: true,
    returnImmediately: true,
    onTaskObservation,
    signal,
    callbackUrl,
    callbackToken,
  });
  return Object.freeze({
    type: "SoftwareMissionSubmission",
    request: request.id,
    mission: mission.id,
    taskId: submission.taskId,
    task: submission.task,
    agentCard: submission.agentCard,
    authentication: submission.authentication,
  });
}

export async function invokeSoftwareMissionOperation(request, { agentCardUrl, send = sendRmnTask, resume = resumeRmnTask, resumeTaskId, onTaskObservation, signal } = {}) {
  const message = requestMessage(request);
  const address = agentUrl(agentCardUrl);
  const transport = resumeTaskId
    ? await resume({ agentUrl: address, taskId: resumeTaskId, inputNi: request.id, requireSignature: true, onTaskObservation, signal })
    : await send({ agentUrl: address, message, requireSignature: true, onTaskObservation, signal });
  const output = extractRmnPart(responseParts(transport.result));
  const response = operationFromBytes(output.bytes);
  if (response?.provider !== ACTOR || response.request !== request.id || typeof response.id !== "string") throw new Error("software mission provider returned a foreign operation result");
  return Object.freeze({ response, transport: { inputNi: transport.inputNi, outputNi: transport.outputNi, agentCard: transport.agentCard, authentication: { agentCardSignatureVerified: true, required: true } } });
}

/** Hire the supplier and return its signed proposal without granting the
 * supplier mutation authority over customer material. */
export async function proposeSoftwareMission(mission, options = {}) {
  const request = missionRequest(mission, options.invocation);
  const { response, transport } = await invokeSoftwareMissionOperation(request, options);
  if (response.type !== "SoftwareMissionExecutionResult" || response.mission !== mission.id) {
    throw new Error("software mission provider returned the wrong result type or mission");
  }
  return Object.freeze({
    ...response.result,
    executionProvider: ACTOR,
    executionReceipt: transport,
  });
}

export async function executeSoftwareMission(mission, options = {}) {
  const proposed = await proposeSoftwareMission(mission, options);
  const customerInduction = induceVerifiedMissionProposal(mission, proposed);
  const outcome = customerInduction
    ? {
        ...proposed.outcome,
        integrated: true,
        inductionRequired: false,
        classification: "integrated",
        integration: { integrated: true, receiver: "software-mission-customer-client" },
      }
    : proposed.outcome;
  return Object.freeze({
    ...proposed,
    outcome,
    ...(customerInduction ? { providerOutcome: proposed.outcome, customerInduction } : {}),
  });
}
