import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { induceVerifiedMissionProposal } from "../src/customer-induction.mjs";

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function fixture() {
  const territory = mkdtempSync(join(tmpdir(), "mission-induction-"));
  writeFileSync(join(territory, "package.json"), "{\"type\":\"module\"}\n");
  writeFileSync(join(territory, "target.test.mjs"), "import './target.mjs';\n");
  const after = Buffer.from("export const delivered = true;\n");
  const mission = {
    territory,
    writablePaths: ["target.mjs"],
    verifyCommand: "node --test",
    acceptanceCommand: "node --test",
  };
  const result = {
    semanticId: "ni:///sha-256;proposal",
    outcome: {
      candidateVerified: true,
      proposal: {
        type: "SoftwareMissionChangeProposal",
        proposalOnly: true,
        customerMutation: false,
        changes: [{
          path: "target.mjs",
          beforeExisted: false,
          beforeDigest: digest(Buffer.alloc(0)),
          afterDigest: digest(after),
          afterBytesBase64: after.toString("base64"),
        }],
      },
    },
  };
  return { territory, mission, result, after };
}

test("customer induces and re-verifies an authorized provider proposal", () => {
  const { territory, mission, result, after } = fixture();
  const receipt = induceVerifiedMissionProposal(mission, result);
  assert.deepEqual(readFileSync(join(territory, "target.mjs")), after);
  assert.deepEqual(receipt.appliedPaths, ["target.mjs"]);
  assert.equal(receipt.verification.passed, true);
});

test("customer refuses a proposal whose before-state drifted", () => {
  const { territory, mission, result } = fixture();
  writeFileSync(join(territory, "target.mjs"), "foreign bytes\n");
  assert.throws(() => induceVerifiedMissionProposal(mission, result), /before-state drift/);
  assert.equal(readFileSync(join(territory, "target.mjs"), "utf8"), "foreign bytes\n");
});
