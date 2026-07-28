import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/activitypub-worker.mjs";

function bindings() {
  const values = new Map(), messages = [];
  return { env: { ACTIVITYPUB_INBOX_BEARER_TOKEN: "x".repeat(32), ACTIVITYPUB_KV: { async put(key, value) { values.set(key, value); }, async get(key) { return values.get(key); }, async list() { return { keys: [...values.keys()].map((name) => ({ name })) }; } }, ACTIVITYPUB_INBOX_QUEUE: { async send(value) { messages.push(value); } } }, messages };
}

test("ActivityPub Worker exposes actor and immutable outbox without state bindings", async () => {
  const actor = await worker.fetch(new Request("https://bare-cedar-fog.561.group/actors/software-mission-execution"), {});
  assert.equal(actor.status, 200); assert.equal((await actor.json()).type, "Service");
  const outbox = await worker.fetch(new Request("https://bare-cedar-fog.561.group/actors/software-mission-execution/outbox"), {});
  assert.equal((await outbox.json()).type, "OrderedCollection");
});

test("ActivityPub Worker refuses absent provider bindings and retains bounded arrivals through KV and Queue", async () => {
  const request = new Request("https://bare-cedar-fog.561.group/actors/software-mission-execution/inbox", { method: "POST", headers: { "content-type": "application/activity+json" }, body: JSON.stringify({ type: "Offer", id: "urn:test:offer" }) });
  const missing = await worker.fetch(request.clone(), {});
  assert.equal(missing.status, 503); assert.equal((await missing.json()).object.code, "provider-binding-absent");
  const { env, messages } = bindings(); const accepted = await worker.fetch(request, env);
  assert.equal(accepted.status, 202); assert.equal(messages.length, 1);
  const inbox = await worker.fetch(new Request("https://bare-cedar-fog.561.group/actors/software-mission-execution/inbox", { headers: { authorization: `Bearer ${env.ACTIVITYPUB_INBOX_BEARER_TOKEN}` } }), env);
  assert.equal((await inbox.json()).totalItems, 1);
});
