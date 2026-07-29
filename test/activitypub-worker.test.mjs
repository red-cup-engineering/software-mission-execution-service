import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/activitypub-worker.mjs";

function cloudEvent() {
  return {
    specversion: "1.0", id: "urn:test:cloud-event", source: "did:web:sender.example", type: "directive",
    time: "2026-07-29T00:00:00.000Z", datacontenttype: "application/json",
    data: { a2a: { messageId: "m1", role: "ROLE_USER", parts: [] }, ucan: "eyJhbGciOiJFZERTQSJ9.payload.signature", captp: { target: "urn:ocapn:sturdyref:test" }, x402: { network: "eip155:5615610" } },
  };
}
function activity() { return { type: "Create", id: "urn:test:create", actor: "https://sender.example/actor", object: cloudEvent() }; }

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

test("ActivityPub Worker refuses absent provider bindings and retains only nested CloudEvent arrivals through KV and Queue", async () => {
  const request = new Request("https://bare-cedar-fog.561.group/actors/software-mission-execution/inbox", { method: "POST", headers: { "content-type": "application/activity+json" }, body: JSON.stringify(activity()) });
  const missing = await worker.fetch(request.clone(), {});
  assert.equal(missing.status, 503); assert.equal((await missing.json()).object.code, "provider-binding-absent");
  const { env, messages } = bindings(); const accepted = await worker.fetch(request, env);
  assert.equal(accepted.status, 202); assert.equal(messages.length, 1);
  const inbox = await worker.fetch(new Request("https://bare-cedar-fog.561.group/actors/software-mission-execution/inbox"), env);
  assert.equal(inbox.status, 403);
});

test("ActivityPub Worker rejects public A2A and CloudEvents lacking capability authorities", async () => {
  const { env } = bindings();
  const publicA2a = new Request("https://bare-cedar-fog.561.group/actors/software-mission-execution/inbox", { method: "POST", body: JSON.stringify({ type: "Message", role: "ROLE_USER" }) });
  assert.equal((await worker.fetch(publicA2a, env)).status, 400);
  const malformed = activity(); delete malformed.object.data.ucan;
  const request = new Request("https://bare-cedar-fog.561.group/actors/software-mission-execution/inbox", { method: "POST", body: JSON.stringify(malformed) });
  assert.equal((await worker.fetch(request, env)).status, 400);
});
