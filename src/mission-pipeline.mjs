import { fileURLToPath } from "node:url";
import { createSettlementStore } from "@emsenn/rwil-rdf-services/client";
import { runMission as defaultRunMission } from "./mission-runtime.mjs";

export const MISSION_EXECUTION_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_MISSION_EXECUTION_DATA_ROOT = fileURLToPath(new URL("../data", import.meta.url));
export const ROUTE_OBSERVATION_CATEGORY = "software-mission-execution.route-observation";

async function appendRouteObservation(record, { dataRoot, rwilAgentUrl, signal }) {
  const store = createSettlementStore({ settlementRoot: MISSION_EXECUTION_ROOT, dataRoot, agentUrl: rwilAgentUrl });
  return store.record({ category: ROUTE_OBSERVATION_CATEGORY, recordedAt: record.finishedAt, record, signal });
}

export async function runMissionPipeline(mission, {
  runMission = defaultRunMission,
  signal,
  dataRoot = DEFAULT_MISSION_EXECUTION_DATA_ROOT,
  rwilAgentUrl = process.env.RWIL_RDF_AGENT,
} = {}) {
  if (!["bounded", "extended"].includes(mission.routingProfile ?? "bounded")) throw new Error("mission routingProfile must be bounded or extended");
  if (mission.routingProfile === "extended" && (typeof mission.extendedRoutingRationale !== "string"
      || mission.extendedRoutingRationale.trim().length < 8 || mission.extendedRoutingRationale.length > 2000)) {
    throw new Error("an extended software mission requires one bounded customer rationale");
  }
  if ((mission.routingProfile ?? "bounded") === "bounded" && mission.extendedRoutingRationale != null) {
    throw new Error("a bounded software mission cannot carry an extended routing rationale");
  }
  if (mission.maxTokens != null && (!Number.isSafeInteger(mission.maxTokens)
      || mission.maxTokens <= 0)) {
    throw new Error("mission maxTokens must be a positive safe integer when supplied");
  }
  const current = await runMission(mission, {
    signal,
    dataRoot,
    rwilAgentUrl,
  });
  const phases = [{ kind: "enterprise-knowledge-pulse", result: current }];

  const finishedAt = new Date().toISOString();
  const observation = {
    type: "SoftwareMissionRouteObservation",
    id: mission.id,
    routePolicy: "enterprise-memory-pulse-only",
    taskClass: mission.taskClass || null,
    finishedAt,
    finalVerified: current.outcome?.verified === true,
    phaseCount: 1,
    inferenceAttempts: current.metrics?.inferenceAttempts || 0,
    usefulCompletions: current.metrics?.usefulCompletions || 0,
    directInteractiveModelCalls: current.metrics?.directInteractiveModelCalls || 0,
    nextActCarrier: "software-trajectory-memory-service",
    sameSessionRetry: false,
    modelEscalationAllowed: false,
  };
  const routeRecord = await appendRouteObservation(observation, { dataRoot, rwilAgentUrl, signal });
  return { ...current, phases, route: { ...observation, graphPath: routeRecord.graphPath, objectPath: routeRecord.objectPath, semanticId: routeRecord.documentNi } };
}
