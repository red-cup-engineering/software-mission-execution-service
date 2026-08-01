import assert from "node:assert/strict";
import test from "node:test";
import { Message, Role } from "@a2a-js/sdk";
import { extractRmnPart, rmnPart } from "@red-cup-engineering/a2a-rmn-part-service";
import { semanticId } from "@red-cup-engineering/rmn-semantic-conformance";
import { relationalWitnessJournalDocument } from "@lenticule-science/witness-journal-rdf-projection-service/client";
import { ACTOR, executeA2aMessage, operationBytes, operationFromBytes } from "../src/a2a-executor.mjs";
import { executeSoftwareMission } from "../src/client.mjs";

const mission = { id: "ni:///sha-256;AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", objective: "bounded test", territory: "/tmp/territory", verifyCommand: "node --test" };
const request = { type: "SoftwareMissionExecutionRequest", provider: ACTOR, mission };

function exact(body) {
  return { id: semanticId(relationalWitnessJournalDocument(body)), ...body };
}

test("the A2A executor carries one canonical RMN mission without a queue", async () => {
  const canonical = exact(request);
  const source = Message.toJSON({ messageId: "00000000-0000-4000-8000-000000000001", contextId: "", taskId: "", role: Role.ROLE_USER, parts: [rmnPart(operationBytes(canonical))], metadata: {}, extensions: [], referenceTaskIds: [] });
  const output = await executeA2aMessage(source, { runMissionPipeline: async (input) => ({ type: "SoftwareMissionTrajectory", id: input.id, outcome: { verified: true } }) });
  const response = operationFromBytes(extractRmnPart(Message.fromJSON(output).parts).bytes);
  assert.equal(response.type, "SoftwareMissionExecutionResult");
  assert.equal(response.request, canonical.id);
  assert.equal(response.result.outcome.verified, true);
});

test("the A2A executor binds a mutable-state observation to its causal activation", async () => {
  const invocation = "ni:///sha-256;BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const canonical = exact({ ...request, invocation });
  const source = Message.toJSON({ messageId: "00000000-0000-4000-8000-000000000003", contextId: "", taskId: "", role: Role.ROLE_USER, parts: [rmnPart(operationBytes(canonical))], metadata: {}, extensions: [], referenceTaskIds: [] });
  let observed;
  await executeA2aMessage(source, { runMissionPipeline: async (input) => {
    observed = input;
    return { type: "SoftwareMissionTrajectory", id: input.id, outcome: { verified: true } };
  } });
  assert.equal(observed.causalInvocation, invocation);
  assert.equal(observed.id, mission.id);
});

test("the client addresses exactly one mission operation to the execution die", async () => {
  const send = async ({ message }) => {
    const source = Message.fromJSON(message), input = operationFromBytes(extractRmnPart(source.parts).bytes);
    const body = { type: "SoftwareMissionExecutionResult", provider: ACTOR, request: input.id, mission: input.mission.id, result: { outcome: { verified: true } } };
    const response = exact(body);
    return { result: Message.fromJSON(Message.toJSON({ messageId: "", contextId: "", taskId: "", role: Role.ROLE_AGENT, parts: [rmnPart(operationBytes(response))], metadata: {}, extensions: [], referenceTaskIds: [] })), inputNi: input.id, outputNi: response.id, agentCard: { name: "mission die" } };
  };
  const result = await executeSoftwareMission(mission, { agentCardUrl: "https://mission.example/.well-known/agent-card.json", send });
  assert.equal(result.outcome.verified, true);
});

test("the client resumes an already-admitted standard A2A task without replaying the mission", async () => {
  let sent = false, resumed;
  const resume = async (input) => {
    resumed = input;
    const body = { type: "SoftwareMissionExecutionResult", provider: ACTOR, request: input.inputNi, mission: mission.id, result: { outcome: { verified: true } } };
    const response = exact(body);
    return { result: Message.fromJSON(Message.toJSON({ messageId: "", contextId: "", taskId: input.taskId, role: Role.ROLE_AGENT, parts: [rmnPart(operationBytes(response))], metadata: {}, extensions: [], referenceTaskIds: [] })), inputNi: input.inputNi, outputNi: response.id, agentCard: { name: "mission die" } };
  };
  const result = await executeSoftwareMission(mission, {
    agentCardUrl: "https://mission.example/.well-known/agent-card.json",
    resumeTaskId: "urn:a2a:task:already-admitted",
    resume,
    send: async () => { sent = true; throw new Error("mission must not be replayed"); },
  });
  assert.equal(sent, false);
  assert.equal(resumed.taskId, "urn:a2a:task:already-admitted");
  assert.equal(result.outcome.verified, true);
});


test("the A2A executor refuses operations owned by sibling dies", async () => {
  const canonical = exact({ type: "AcceptanceCapsuleProcurementRequest", provider: ACTOR, input: { id: "urn:acceptance:two" } });
  const source = Message.toJSON({ messageId: "00000000-0000-4000-8000-000000000002", contextId: "", taskId: "", role: Role.ROLE_USER, parts: [rmnPart(operationBytes(canonical))], metadata: {}, extensions: [], referenceTaskIds: [] });
  await assert.rejects(executeA2aMessage(source), /unsupported software mission operation/);
});
