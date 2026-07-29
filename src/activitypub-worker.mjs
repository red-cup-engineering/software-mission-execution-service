import outboxItems from "../content/activitypub/outbox.json" with { type: "json" };

const CONTEXT = "https://www.w3.org/ns/activitystreams";
const MEDIA_TYPE = "application/activity+json";
const MAX_ACTIVITY_BYTES = 256 * 1024;

function activityJson(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": MEDIA_TYPE, "cache-control": "no-store", ...headers },
  });
}

function refusal(code, detail, status = 503) {
  return activityJson({
    "@context": CONTEXT,
    type: "Reject",
    object: { type: "ActivityPubProviderRefusal", code, detail },
  }, status);
}

function actor(origin) { return new URL("/actors/software-mission-execution", origin).href; }
function inbox(origin) { return `${actor(origin)}/inbox`; }
function outbox(origin) { return `${actor(origin)}/outbox`; }

function hasCarrierBindings(env) {
  return env?.ACTIVITYPUB_KV && typeof env.ACTIVITYPUB_KV.put === "function"
    && env?.ACTIVITYPUB_INBOX_QUEUE && typeof env.ACTIVITYPUB_INBOX_QUEUE.send === "function";
}

function nonempty(value) { return typeof value === "string" && value.length > 0; }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** ActivityPub/CloudEvents is the public membrane; A2A is only its inner task. */
export function admitActivityPubCloudEvent(activity) {
  if (!record(activity) || activity.type !== "Create" || !nonempty(activity.actor) || !record(activity.object)) {
    throw new TypeError("inbox accepts only an ActivityPub Create from an identified actor");
  }
  const event = activity.object;
  if (event.specversion !== "1.0" || !nonempty(event.id) || !nonempty(event.source)
      || !nonempty(event.type) || !nonempty(event.time) || event.datacontenttype !== "application/json" || !record(event.data)) {
    throw new TypeError("Create object must be a structured CloudEvents 1.0 JSON envelope");
  }
  const { a2a, ucan, captp, x402 } = event.data;
  if (!record(a2a) || !nonempty(ucan) || !record(captp) || !record(x402)) {
    throw new TypeError("CloudEvent data must carry A2A together with UCAN, CapTP, and x402 authority");
  }
  return Object.freeze(event);
}

function actorDocument(origin) {
  return {
    "@context": CONTEXT,
    id: actor(origin), type: "Service", preferredUsername: "software-mission-execution",
    name: "Software Mission Execution Service",
    summary: "Receives ActivityPub Creates whose objects are CloudEvents carrying admitted capability work.",
    inbox: inbox(origin), outbox: outbox(origin),
    attachment: outboxItems[0]?.object?.attachment ?? [],
  };
}

async function retainArrival(request, env, origin) {
  if (!hasCarrierBindings(env)) return refusal("provider-binding-absent", "ACTIVITYPUB_KV and ACTIVITYPUB_INBOX_QUEUE bindings are required");
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ACTIVITY_BYTES) return refusal("activity-too-large", "inbound activity exceeds the 256 KiB carrier bound", 413);
  let activity;
  try { activity = await request.json(); } catch { return refusal("invalid-activity", "inbound body is not JSON", 400); }
  let cloudEvent;
  try { cloudEvent = admitActivityPubCloudEvent(activity); } catch (error) {
    return refusal("inadmissible-carrier", error instanceof Error ? error.message : String(error), 400);
  }
  const id = crypto.randomUUID();
  const arrival = Object.freeze({ id, receivedAt: new Date().toISOString(), recipient: inbox(origin), activity, cloudEvent });
  await env.ACTIVITYPUB_KV.put(`activitypub:inbox:${id}`, JSON.stringify(arrival));
  await env.ACTIVITYPUB_INBOX_QUEUE.send({ type: "ActivityPubInboxArrival", id, key: `activitypub:inbox:${id}` });
  return activityJson({ "@context": CONTEXT, type: "Accept", actor: actor(origin), object: cloudEvent.id }, 202);
}

async function deliverArrival(message, env) {
  if (!hasCarrierBindings(env)) throw new Error("ACTIVITYPUB_KV binding is required");
  const url = env?.MISSION_EXECUTION_INTERNAL_URL;
  const key = env?.MISSION_EXECUTION_DELIVERY_KEY;
  if (!nonempty(url) || !nonempty(key) || key.length < 32) throw new Error("cloud execution delivery binding is absent");
  const arrival = await env.ACTIVITYPUB_KV.get(message.key, "json");
  if (!record(arrival) || !record(arrival.cloudEvent)) throw new Error("queued arrival receipt is absent or malformed");
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-activitypub-delivery-key": key }, body: JSON.stringify(arrival) });
  if (!response.ok) throw new Error(`cloud execution refused queued arrival: ${response.status}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), origin = url.origin;
    if (request.method === "GET" && url.pathname === "/actors/software-mission-execution") return activityJson(actorDocument(origin));
    if (request.method === "GET" && url.pathname === "/actors/software-mission-execution/outbox") return activityJson({ "@context": CONTEXT, id: outbox(origin), type: "OrderedCollection", totalItems: outboxItems.length, orderedItems: outboxItems });
    if (url.pathname === "/actors/software-mission-execution/inbox") {
      if (request.method === "POST") return retainArrival(request, env, origin);
      if (request.method === "GET") {
        if (!hasCarrierBindings(env)) return refusal("provider-binding-absent", "ACTIVITYPUB_KV and ACTIVITYPUB_INBOX_QUEUE bindings are required");
        return refusal("inbox-not-readable", "inbox arrivals are private custody records; use delivered ActivityPub receipts", 403);
      }
    }
    return refusal("not-found", "no ActivityPub carrier endpoint matches this request", 404);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try { await deliverArrival(message.body, env); message.ack(); }
      catch { message.retry(); }
    }
  },
};
