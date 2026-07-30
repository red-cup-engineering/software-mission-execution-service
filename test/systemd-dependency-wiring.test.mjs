import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const unit = readFileSync(new URL("../ops/systemd/bare-cedar-fog-software-mission-execution.service", import.meta.url), "utf8");

test("mission-dependency-wiring", () => {
  const requires = unit.match(/^Requires=(.*)$/mu)?.[1]?.split(/\s+/u) ?? [];
  const after = unit.match(/^After=(.*)$/mu)?.[1]?.split(/\s+/u) ?? [];
  for (const service of ["software-trajectory-memory-service.service"]) {
    assert.ok(requires.includes(service), `${service} must be required`);
    assert.ok(after.includes(service), `${service} must order startup`);
  }
  assert.ok(!requires.includes("inference-work-lot-service.service"), "the cloud market is not a local systemd dependency");
  assert.ok(!after.includes("inference-work-lot-service.service"), "the cloud market does not order local startup");
  assert.match(unit, /^Environment=INFERENCE_WORK_LOT_AGENT_CARD_URL=https:\/\//mu, "the admitted cloud market address remains the owner input");
  for (const variable of [
    "UNION_LISS_AGENT_CARD_URL", "UNION_GROQ_AGENT_CARD_URL", "UNION_GEMINI_AGENT_CARD_URL",
    "UNION_CLAUDE_CODE_AGENT_CARD_URL", "UNION_NVIDIA_AGENT_CARD_URL", "WIT_TRANSITION_ASSAY_AGENT",
    "PROTECTED_ACCEPTANCE_AGENT_CARD_URL", "ACCEPTANCE_CAPSULE_PROCUREMENT_AGENT_CARD_URL",
  ]) assert.doesNotMatch(unit, new RegExp(`^Environment=${variable}=`, "mu"), `${variable} is not consumed by this die`);
});
