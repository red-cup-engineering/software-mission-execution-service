import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Message, Role } from "@a2a-js/sdk";
import { extractRmnPart, rmnPart } from "@red-cup-engineering/a2a-rmn-part-service";
import { semanticId } from "@red-cup-engineering/rmn-semantic-conformance";
import { relationalRwilDocument } from "@lenticule-science/rwil-rdf-projection-service/client";
import { ACTOR, executeA2aMessage, operationBytes, operationFromBytes } from "../src/a2a-executor.mjs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const locus = readJson("../content/foam/locus.json");
const card = readJson("../content/agent-cards/software-mission-execution.json");
const offer = readJson("../content/offers/current.json");
const manifest = readJson("../package.json");
const operation = "execute-software-mission";

function exact(body) {
  return { id: semanticId(relationalRwilDocument(body)), ...body };
}

test("a generic Actor sees one consistent orchestration operation across FOAM, discovery, package, and Agent Card", () => {
  assert.equal(locus.actor, ACTOR);
  assert.equal(locus.operation, operation);
  assert.equal(locus.messageFace, offer.agentCard);
  assert.equal(offer.provider, ACTOR);
  assert.equal(offer.operation, operation);
  assert.ok(card.skills.some((skill) => skill.id === operation));
  assert.ok(Object.hasOwn(manifest["x-agentic-metro-enterprise"]["operation-catalog"], operation));
  assert.deepEqual(manifest["x-agentic-metro-enterprise"]["x-foam-locus"].address, locus.address);
  assert.equal(manifest["x-agentic-metro-enterprise"]["x-foam-locus"].projection, "content/foam/locus.json");
  assert.deepEqual(locus.realizedBy.map(({ capability }) => capability), [
    "project-bounded-coding-context",
    "discover-and-hire-inference-provider",
    "retain-provider-and-trajectory-receipts",
    "verify-with-author-excluded-acceptance",
    "resume-standard-a2a-task-without-replay",
  ]);
});

test("the FOAM-visible operation reaches the existing executor without performing provider work", async () => {
  const mission = {
    id: "ni:///sha-256;AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    objective: "assay Actor-facing orchestration accessibility",
    territory: "/tmp/foam-accessibility-assay",
    verifyCommand: "node --test",
  };
  const request = exact({ type: "SoftwareMissionExecutionRequest", provider: locus.actor, mission });
  const message = Message.toJSON({
    messageId: "00000000-0000-4000-8000-000000000091",
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: [rmnPart(operationBytes(request))],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  });
  const output = await executeA2aMessage(message, {
    runMissionPipeline: async (input) => ({
      type: "SoftwareMissionTrajectory",
      id: input.id,
      outcome: { verified: true, assayOnly: true },
    }),
  });
  const response = operationFromBytes(extractRmnPart(Message.fromJSON(output).parts).bytes);
  assert.equal(response.type, "SoftwareMissionExecutionResult");
  assert.equal(response.provider, locus.actor);
  assert.equal(response.request, request.id);
  assert.deepEqual(response.result.outcome, { verified: true, assayOnly: true });
});
