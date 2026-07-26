import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { submitSoftwareMission } from "../src/client.mjs";
import { runMission } from "../src/mission-runtime.mjs";

test("mission submission yields durable A2A custody without waiting for execution", async () => {
  let observed;
  const submission = await submitSoftwareMission({ id: "urn:test:mission:async" }, {
    agentCardUrl: "https://mission.example/.well-known/agent-card.json",
    submit: async (input) => {
      observed = input;
      return { taskId: "task-1", task: { id: "task-1", status: { state: "working" } }, agentCard: { name: "mission" }, authentication: { verified: true } };
    },
  });
  assert.equal(observed.returnImmediately, true);
  assert.equal(observed.requireSignature, true);
  assert.equal(submission.taskId, "task-1");
  assert.equal(submission.mission, "urn:test:mission:async");
});

test("a repeated demand resumes its causally seated workspace without rebuying completed inference", async () => {
  const territory = mkdtempSync(join(tmpdir(), "mission-checkpoint-test-"));
  writeFileSync(join(territory, "calc.mjs"), "export const add = (a, b) => a - b;\n");
  writeFileSync(join(territory, "calc.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { add } from "./calc.mjs";',
    'test("adds", () => assert.equal(add(2, 3), 5));',
    "",
  ].join("\n"));
  let checkpoint = null, contacts = 0;
  const options = {
    dispatch: async ([job]) => {
      contacts += 1;
      return [{
        id: job.id,
        text: "TOOL: edit\nPATH: calc.mjs\nSEARCH:\n```js\na - b\n```\nREPLACE:\n```js\na + b\n```",
        attempts: [],
      }];
    },
    appendCheckpoint: async (value) => { checkpoint = structuredClone(value); return { id: value.id }; },
    readCheckpoint: async () => checkpoint,
    appendTrajectory: async () => ({ graphPath: "memory://trajectory", objectPath: "memory://object", documentNi: "ni:///sha-256;trajectory" }),
    recallTrajectories: async () => [],
    resolveInducedTrajectory: async () => null,
    promotionReadout: async () => ({ eligible: false }),
  };
  const demand = {
    id: "urn:test:checkpointed-mission",
    objective: "Repair addition.",
    territory,
    verifyCommand: "node --test calc.test.mjs",
    acceptanceCommand: "node --test calc.test.mjs",
    writablePaths: ["calc.mjs"],
    focusPaths: ["calc.mjs", "calc.test.mjs"],
    testVectors: [{ id: "addition", given: ["two integers"], when: "they are added", then: ["the sum is returned"], forbidden: [] }],
  };
  const first = await runMission(demand, options);
  const second = await runMission(demand, options);
  assert.equal(first.outcome.verified, true);
  assert.equal(second.outcome.verified, true);
  assert.equal(contacts, 1);
  assert.equal(second.metrics.inferenceContacts, 1);
  assert.equal(checkpoint.status, "verified");
  assert.equal(checkpoint.ordinal, "2");
  assert.equal(checkpoint.changes[0].path, "calc.mjs");
});
