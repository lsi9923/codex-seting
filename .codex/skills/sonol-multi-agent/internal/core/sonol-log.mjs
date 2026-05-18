import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultLogDir as resolveDefaultLogDir } from "./sonol-runtime-paths.mjs";

function ensureLogDir() {
  mkdirSync(resolveDefaultLogDir(), { recursive: true });
}

function toDateStamp(timestamp = new Date().toISOString()) {
  return String(timestamp).slice(0, 10);
}

function toLogFile(kind, timestamp) {
  return resolve(resolveDefaultLogDir(), `${kind}-${toDateStamp(timestamp)}.jsonl`);
}

export function appendStructuredLog(kind, entry = {}) {
  const timestamp = entry.timestamp ?? new Date().toISOString();
  const payload = {
    timestamp,
    kind,
    pid: process.pid,
    ...entry
  };

  ensureLogDir();
  appendFileSync(toLogFile(kind, timestamp), `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}

export function listStructuredLogs(kind, { runId, limit = 100 } = {}) {
  ensureLogDir();
  const logDir = resolveDefaultLogDir();
  const prefix = `${kind}-`;
  const files = readdirSync(logDir)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".jsonl"))
    .sort()
    .reverse();

  const entries = [];
  for (const file of files) {
    const lines = readFileSync(resolve(logDir, file), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const entry = JSON.parse(lines[index]);
        if (runId && entry.run_id !== runId) {
          continue;
        }
        entries.push(entry);
        if (entries.length >= limit) {
          return entries;
        }
      } catch {
      }
    }
  }

  return entries;
}

export function defaultLogDir() {
  ensureLogDir();
  return resolveDefaultLogDir();
}
