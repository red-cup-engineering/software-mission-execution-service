import { fileURLToPath } from "node:url";
import { createSettlementStore } from "@lenticule-science/rwil-rdf-projection-service/client";
import { runMission as defaultRunMission } from "./mission-runtime.mjs";

export const MISSION_EXECUTION_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_MISSION_EXECUTION_DATA_ROOT = fileURLToPath(new URL("../data", import.meta.url));
export const ROUTE_OBSERVATION_CATEGORY = "software-mission-execution.route-observation";

async function appendRouteObservation(record, { dataRoot, rwilAgentUrl, settlementCaip2, signal }) {
  const store = createSettlementStore({
    settlementRoot: MISSION_EXECUTION_ROOT,
    agentUrl: rwilAgentUrl,
    caip2: settlementCaip2,
  });
  return store.record({ category: ROUTE_OBSERVATION_CATEGORY, recordedAt: record.finishedAt, record, signal });
}

export async function runMissionPipeline(mission, {
  runMission = defaultRunMission,
  signal,
  dataRoot = process.env.SOFTWARE_MISSION_EXECUTION_DATA_ROOT ?? DEFAULT_MISSION_EXECUTION_DATA_ROOT,
  rwilAgentUrl = process.env.RWIL_RDF_AGENT,
  settlementCaip2 = process.env.SETTLEMENT_CAIP2,
} = {}) {
  if (mission.maxTokens != null) throw new Error("mission maxTokens is retired; provider capacity and market consideration determine admissible output");
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
    finalAnswered: current.outcome?.answered === true,
    phaseCount: 1,
    inferenceAttempts: current.metrics?.inferenceAttempts || 0,
    usefulCompletions: current.metrics?.usefulCompletions || 0,
    directInteractiveModelCalls: current.metrics?.directInteractiveModelCalls || 0,
    nextActCarrier: "software-trajectory-memory-service",
    continuation: current.processNode?.fixedPoint
      ? { state: "obstructed-fixed-point", obstruction: current.processNode.fixedPoint }
      : current.outcome?.verified === true
        ? { state: "awaiting-customer-induction" }
        : current.outcome?.answered === true
          ? { state: "answered" }
        : { state: "durable-demand-open", nextAct: "return-to-capability-market" },
  };
  const routeRecord = await appendRouteObservation(observation, {
    dataRoot,
    rwilAgentUrl,
    settlementCaip2,
    signal,
  });
  return { ...current, phases, route: { ...observation, networkReference: routeRecord.reference, semanticId: routeRecord.documentNi } };
}
