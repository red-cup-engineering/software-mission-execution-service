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

function authorized(request, env) {
  const token = env?.ACTIVITYPUB_INBOX_BEARER_TOKEN;
  return typeof token === "string" && token.length >= 32
    && request.headers.get("authorization") === `Bearer ${token}`;
}

function actorDocument(origin) {
  return {
    "@context": CONTEXT,
    id: actor(origin), type: "Service", preferredUsername: "software-mission-execution",
    name: "Software Mission Execution Service",
    summary: "Executes bounded software missions through purchased inference and protected acceptance.",
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
  if (!activity || typeof activity !== "object" || typeof activity.type !== "string") return refusal("invalid-activity", "inbound body is not an ActivityStreams activity", 400);
  const id = crypto.randomUUID();
  const arrival = Object.freeze({ id, receivedAt: new Date().toISOString(), recipient: inbox(origin), activity });
  await env.ACTIVITYPUB_KV.put(`activitypub:inbox:${id}`, JSON.stringify(arrival));
  await env.ACTIVITYPUB_INBOX_QUEUE.send({ type: "ActivityPubInboxArrival", id, key: `activitypub:inbox:${id}` });
  return activityJson({ "@context": CONTEXT, type: "Accept", actor: actor(origin), object: activity.id ?? id }, 202);
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
        if (!authorized(request, env)) return refusal("authorization-required", "a bearer token is required to read the private inbox", 401);
        const listed = await env.ACTIVITYPUB_KV.list({ prefix: "activitypub:inbox:" });
        const values = await Promise.all(listed.keys.slice(0, 100).map(async ({ name }) => JSON.parse(await env.ACTIVITYPUB_KV.get(name))));
        return activityJson({ "@context": CONTEXT, id: inbox(origin), type: "OrderedCollection", totalItems: values.length, orderedItems: values });
      }
    }
    return refusal("not-found", "no ActivityPub carrier endpoint matches this request", 404);
  },
};
