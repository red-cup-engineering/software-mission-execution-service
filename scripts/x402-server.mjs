#!/usr/bin/env node

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import express from "express";
import {
  createExactEvmPaymentBoundary,
  x402PaymentIdentity,
  x402SettlementEvidence,
} from "@red-cup-engineering/x402-services-section";
import { executeSoftwareMission } from "../src/client.mjs";

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function quote() {
  const response = await fetch(required("PRICE_QUOTE_URL"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await jsonFile(required("PRICE_QUOTE_DEMAND"))),
  });
  const body = await response.json();
  if (!response.ok || body?.ok !== true) throw new Error(`pricing provider refused: ${body?.refusal?.message ?? response.status}`);
  const amount = body.result?.consideration?.amount;
  if (amount?.denominator !== "1" || !/^[1-9][0-9]*$/u.test(amount.numerator ?? "")) {
    throw new Error("x402 requires a positive integer number of atomic settlement units");
  }
  return Object.freeze({ result: body.result, atomicAmount: amount.numerator });
}

async function appendReceipt(path, record) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function receiptState(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { intents: new Map(), settlements: new Map(), terminal: new Map() };
    throw error;
  }
  const records = source.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return {
    intents: new Map(records
      .filter((record) => record?.type === "X402PaidSoftwareMissionIntent")
      .map((record) => [record.invocation, record])),
    settlements: new Map(records
      .filter((record) => record?.type === "X402SettlementReceipt")
      .map((record) => [record.invocation, record])),
    terminal: new Map(records
      .filter((record) => [
        "X402PaidSoftwareMissionReceipt",
        "X402PaidSoftwareMissionRecoveryReceipt",
        "X402PaidSoftwareMissionRefusal",
      ].includes(record?.type))
      .map((record) => [record.invocation, record])),
  };
}

export async function main() {
  const network = required("SETTLEMENT_CAIP2");
  const settlement = required("SETTLEMENT_ACCOUNT");
  const asset = required("X402_ASSET");
  const resource = "/x402/software-mission-execution/invoke";
  const receiptPath = required("X402_RECEIPT_PATH");
  const priced = await quote();
  const offer = await jsonFile(required("CAPABILITY_OFFER_PATH"));
  if (offer.price.amount !== priced.atomicAmount || offer.price.network !== network
      || offer.price.asset.toLowerCase() !== asset.toLowerCase()
      || offer.price.payTo?.toLowerCase() !== settlement.split(":").at(-1).toLowerCase()) {
    throw new Error("published offer drifted from the hired pricing provider");
  }
  const recovered = await receiptState(receiptPath);
  const pending = new Map(recovered.intents);
  const settlements = new Map(recovered.settlements);
  const terminal = new Map(recovered.terminal);
  const running = new Set();
  async function executePaidMission(invocation, intent, settlementEvidence, recovery = false) {
    if (running.has(invocation)) throw new Error("paid mission obligation is already executing");
    running.add(invocation);
    try {
      const result = await executeSoftwareMission(intent.mission, {
        agentCardUrl: required("SOFTWARE_MISSION_AGENT_CARD_URL"),
      });
      const receipt = {
        type: recovery ? "X402PaidSoftwareMissionRecoveryReceipt" : "X402PaidSoftwareMissionReceipt",
        invocation,
        settlement: settlementEvidence,
        result,
      };
      terminal.set(invocation, receipt);
      await appendReceipt(receiptPath, receipt);
    } catch (error) {
      const refusal = {
        type: "X402PaidSoftwareMissionRefusal",
        invocation,
        settlement: settlementEvidence,
        reason: error instanceof Error ? error.message : String(error),
      };
      terminal.set(invocation, refusal);
      await appendReceipt(receiptPath, refusal);
    } finally {
      running.delete(invocation);
    }
  }
  const boundary = createExactEvmPaymentBoundary({
    network,
    facilitatorUrl: required("X402_FACILITATOR_URL"),
    routes: {
      [`POST ${resource}`]: {
        accepts: [{
          scheme: "exact",
          network,
          price: {
            amount: priced.atomicAmount,
            asset,
            extra: { name: required("X402_ASSET_NAME"), version: required("X402_ASSET_VERSION") },
          },
          payTo: settlement.split(":").at(-1),
        }],
        description: "Execute one bounded software mission.",
      },
    },
    afterSettle: async (event) => {
      const settlementEvidence = x402SettlementEvidence(event);
      const invocation = settlementEvidence.invocation;
      const intent = pending.get(invocation);
      if (!intent) throw new Error("settled payment has no exact mission intent");
      const settlementReceipt = { type: "X402SettlementReceipt", invocation, settlement: settlementEvidence, pricing: priced.result };
      settlements.set(invocation, settlementReceipt);
      await appendReceipt(receiptPath, settlementReceipt);
      await executePaidMission(invocation, intent, settlementEvidence);
    },
  });
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? "1mb" }));
  app.get("/x402/software-mission-execution/offer", (_request, response) => response.json({ ...offer, pricing: priced.result }));
  async function admitCustomerAuthority(request, response, next) {
    try {
      const authorization = request.get("authorization") ?? "";
      const matched = /^OCapN (urn:ocapn:sturdyref:[A-Za-z0-9_-]{43})$/u.exec(authorization);
      if (!matched) throw new Error("one OCapN sturdy reference is required");
      const admitted = await fetch(required("OCAPN_ADMISSION_URL"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sturdyRef: matched[1], locus: "execute-software-mission" }),
      }).then((result) => result.json());
      if (admitted?.admitted !== true) throw new Error(`OCapN provider refused: ${admitted?.reason ?? "unknown"}`);
      await appendReceipt(receiptPath, { type: "OCapNAdmissionReceipt", operation: "execute-software-mission", admission: admitted });
      next();
    } catch (error) {
      response.status(403).json({ ok: false, refusal: { type: "OCapNSturdyRefAdmissionRefusal", reason: error.message } });
    }
  }
  app.post(resource, admitCustomerAuthority);
  app.use(boundary.middleware);
  app.post(resource, async (request, response) => {
    const invocation = x402PaymentIdentity(request.get("payment-signature"));
    const intent = { type: "X402PaidSoftwareMissionIntent", invocation, mission: structuredClone(request.body) };
    await appendReceipt(receiptPath, intent);
    pending.set(invocation, intent);
    response.status(202).json({ ok: true, invocation, status: "settlement-pending", result: `/x402/software-mission-execution/result/${invocation.slice(7)}` });
  });
  app.get("/x402/software-mission-execution/result/:id", (request, response) => {
    if (!/^[0-9a-f]{64}$/u.test(request.params.id)) return response.status(400).json({ ok: false, refusal: { type: "InvalidInvocationIdentity" } });
    const invocation = `sha256:${request.params.id}`;
    const recoveryPending = running.has(invocation);
    const isTerminal = terminal.has(invocation) && !recoveryPending;
    return response.status(isTerminal ? 200 : 202).json({
      ok: true,
      invocation,
      status: recoveryPending ? "recovery-pending" : isTerminal ? "terminal" : "pending",
      terminal: isTerminal ? terminal.get(invocation) : null,
    });
  });
  app.post("/x402/software-mission-execution/recover/:id", admitCustomerAuthority, (request, response) => {
    if (!/^[0-9a-f]{64}$/u.test(request.params.id)) {
      return response.status(400).json({ ok: false, refusal: { type: "InvalidInvocationIdentity" } });
    }
    const invocation = `sha256:${request.params.id}`;
    const intent = pending.get(invocation);
    const settlementReceipt = settlements.get(invocation);
    const prior = terminal.get(invocation);
    if (!intent || settlementReceipt?.settlement?.success !== true
        || prior?.type !== "X402PaidSoftwareMissionRefusal") {
      return response.status(409).json({ ok: false, refusal: { type: "PaidObligationNotRecoverable" } });
    }
    if (running.has(invocation)) {
      return response.status(202).json({ ok: true, invocation, status: "recovery-pending" });
    }
    running.add(invocation);
    Promise.resolve().then(() => {
      running.delete(invocation);
      executePaidMission(invocation, intent, settlementReceipt.settlement, true)
        .catch((error) => process.stderr.write(`${error.stack ?? error.message}\n`));
    });
    return response.status(202).json({ ok: true, invocation, status: "recovery-started" });
  });
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? "15629");
  app.listen(port, host, () => process.stdout.write(`${JSON.stringify({ type: "SoftwareMissionX402Listening", host, port, network, atomicAmount: priced.atomicAmount })}\n`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
