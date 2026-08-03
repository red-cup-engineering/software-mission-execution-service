import { runMissionPipeline } from "./mission-pipeline.mjs";
import { identifyOperation } from "./semantic-content.mjs";

export const ACTOR = "urn:ame:software-mission-execution-service";

function record(body) {
  return Object.freeze({ id: identifyOperation(body).id, ...body });
}

function missionRequest(mission, invocation) {
  return record({
    type: "SoftwareMissionExecutionRequest",
    provider: ACTOR,
    mission,
    ...(typeof invocation === "string" && invocation !== "" ? { invocation } : {}),
  });
}

export async function proposeSoftwareMission(mission, options = {}) {
  if (!mission || typeof mission !== "object" || typeof mission.id !== "string" || mission.id === "") {
    throw new TypeError("software mission requires one identified mission value");
  }
  const request = missionRequest(mission, options.invocation);
  const executable = typeof options.invocation === "string" && options.invocation !== ""
    ? { ...mission, causalInvocation: options.invocation }
    : mission;
  const result = await (options.runMissionPipeline ?? runMissionPipeline)(executable, options.execution ?? options);
  const response = record({
    type: "SoftwareMissionExecutionResult",
    provider: ACTOR,
    request: request.id,
    mission: mission.id,
    result,
  });
  return Object.freeze({
    ...result,
    executionProvider: ACTOR,
    executionReceipt: Object.freeze({ input: request.id, output: response.id }),
  });
}

export const executeSoftwareMission = proposeSoftwareMission;
