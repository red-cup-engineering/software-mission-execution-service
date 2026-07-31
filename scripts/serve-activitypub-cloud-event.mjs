#!/usr/bin/env node
/**
 * Private Cloud Run terminus for the Cloudflare ActivityPub carrier.
 *
 * There is intentionally no agent card, JSON-RPC route, or REST A2A route in
 * this process. The only admitted HTTP request is a queued ActivityPub
 * arrival authenticated by the edge delivery capability. A2A stays inside the
 * already-admitted CloudEvent and is decoded only here.
 */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { executeA2aMessage } from "../src/a2a-executor.mjs";

const MAX_BODY_BYTES = 256 * 1024;
function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length < 32) throw new Error(`${name} must be a 32+ byte delivery capability`);
  return value;
}
function sameCapability(actual, expected) {
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function respond(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
async function bodyOf(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("arrival exceeds CloudEvent carrier bound");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function cloudEventOf(arrival) {
  const event = arrival?.cloudEvent;
  const data = event?.data;
  if (!event || event.specversion !== "1.0" || event.datacontenttype !== "application/json"
      || !data || typeof data !== "object" || !data.a2a || !data.ucan || !data.captp || !data.x402) {
    throw new Error("arrival is not an admitted ActivityPub(CloudEvent(A2A(UCAN,x402,CapTP))) envelope");
  }
  return event;
}

export function createActivityPubCloudEventServer({ deliveryKey = required("MISSION_EXECUTION_DELIVERY_KEY"), execute = executeA2aMessage } = {}) {
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/internal/activitypub-cloud-event") return respond(response, 404, { ok: false, refusal: "no-public-a2a-surface" });
    if (!sameCapability(request.headers["x-activitypub-delivery-key"], deliveryKey)) return respond(response, 403, { ok: false, refusal: "edge-delivery-capability-required" });
    try {
      const event = cloudEventOf(await bodyOf(request));
      const result = await execute(event.data.a2a);
      return respond(response, 202, { ok: true, cloudEvent: event.id, result });
    } catch (error) {
      return respond(response, 400, { ok: false, refusal: error instanceof Error ? error.message : String(error) });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createActivityPubCloudEventServer();
  server.listen(Number(process.env.PORT ?? "8080"), process.env.HOST ?? "0.0.0.0");
}
