import { Message, Role } from "@a2a-js/sdk";
import { extractRmnPart, rmnPart } from "@red-cup-engineering/a2a-rmn-part-service";
import { decodeSemantic, semanticBytes, semanticId } from "@red-cup-engineering/rmn-semantic-conformance";
import { decodeRelationalValue } from "@red-cup-engineering/rmn-semantic-conformance/relational-value";
import { relationalRwilDocument } from "@lenticule-science/rwil-rdf-projection-service/client";
import { runMissionPipeline } from "./mission-pipeline.mjs";

export const ACTOR = "urn:ame:software-mission-execution-service";

function rmnId(value) { return semanticId(relationalRwilDocument(value)); }
function record(body) { return Object.freeze({ id: rmnId(body), ...body }); }
export function operationBytes(value) { return semanticBytes(relationalRwilDocument(value)); }
export function operationFromBytes(bytes) {
  const term = decodeSemantic(bytes);
  if (term?.[0] !== "ascribe" || term.length !== 3) throw new Error("mission operation is not one typed relational RMN document");
  return decodeRelationalValue(term[1], term[2]);
}
function exact(value) {
  if (!value || typeof value !== "object") return false;
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "id"));
  return value.id === rmnId(body);
}

export async function executeOperation(request, options = {}) {
  if (!exact(request) || request.provider !== ACTOR) throw new Error("exact provider-addressed canonical RMN operation is required");
  if (request.type === "SoftwareMissionExecutionRequest") {
    if (!request.mission || typeof request.mission !== "object") throw new Error("software mission request requires one mission");
    const mission = typeof request.invocation === "string" && request.invocation !== ""
      ? { ...request.mission, causalInvocation: request.invocation }
      : request.mission;
    const result = await (options.runMissionPipeline ?? runMissionPipeline)(mission, options.execution ?? {});
    return record({ type: "SoftwareMissionExecutionResult", provider: ACTOR, request: request.id, mission: request.mission.id, result });
  }
  throw new Error(`unsupported software mission operation: ${String(request.type)}`);
}

export async function executeA2aMessage(source, options = {}) {
  const message = Message.fromJSON(source);
  if (message.role !== Role.ROLE_USER) throw new Error("software mission executor requires an A2A user Message");
  const input = extractRmnPart(message.parts);
  const response = await executeOperation(operationFromBytes(input.bytes), options);
  return Message.toJSON({
    messageId: "", contextId: message.contextId ?? "", taskId: message.taskId ?? "", role: Role.ROLE_AGENT,
    parts: [rmnPart(operationBytes(response))],
    metadata: { inputNi: input.ni, outputNi: response.id, provider: ACTOR },
    extensions: [], referenceTaskIds: [],
  });
}
