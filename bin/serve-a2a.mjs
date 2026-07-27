#!/usr/bin/env node
import { resolve } from "node:path";
import { serveContractedAgent } from "@red-cup-engineering/a2a-contracted-agent-service";
const ROOT = resolve(import.meta.dirname, "..");
serveContractedAgent({ port: Number(process.env.PORT ?? "8795"), host: process.env.HOST ?? "127.0.0.1", baseUrl: process.env.BASE_URL, agentCard: resolve(ROOT, "content/agent-cards/software-mission-execution.json"), executor: process.execPath, executorArgs: [resolve(ROOT, "bin/execute-a2a-message.mjs")] }).then(({ server, baseUrl }) => { process.stdout.write(`${baseUrl}\n`); const stop = () => server.close(() => process.exit(0)); process.once("SIGINT", stop); process.once("SIGTERM", stop); }).catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
