/**
 * Cabinet Daemon — unified background server
 *
 * Combines:
 * - API Session Manager (headless agent sessions via API providers)
 * - Job Scheduler (node-cron for agent jobs)
 * - WebSocket Event Bus (real-time updates to frontend)
 * - SQLite database initialization
 *
 * Usage: npx tsx server/cabinet-daemon.ts
 */

import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import http from "http";
import fs from "fs";
import cron from "node-cron";
import yaml from "js-yaml";
import chokidar from "chokidar";
import matter from "gray-matter";
import { getDb, closeDb } from "./db";
import { DATA_DIR } from "../src/lib/storage/path-utils";
import {
  getAppOrigin,
  getDaemonPort,
} from "../src/lib/runtime/runtime-config";
import { resolveProviderId } from "../src/lib/agents/provider-runtime";
import { providerRegistry } from "../src/lib/agents/provider-registry";
import {
  appendConversationTranscript,
  finalizeConversation,
  parseCabinetBlock,
  readConversationMeta,
  readConversationTranscript,
} from "../src/lib/agents/conversation-store";
import {
  getTokenFromAuthorizationHeader,
  isDaemonTokenValid,
} from "../src/lib/agents/daemon-auth";
import {
  normalizeJobConfig,
  normalizeJobId,
} from "../src/lib/jobs/job-normalization";

const PORT = getDaemonPort();
const AGENTS_DIR = path.join(DATA_DIR, ".agents");
const ALLOWED_BROWSER_ORIGINS = new Set(
  [
    getAppOrigin(),
    ...(process.env.CABINET_APP_ORIGIN
      ? process.env.CABINET_APP_ORIGIN.split(",").map((value) => value.trim()).filter(Boolean)
      : []),
  ]
);

// ----- Database Initialization -----

console.log("Initializing Cabinet database...");
getDb();
console.log("Database ready.");

// ===== API Session Management =====

interface ApiSession {
  id: string;
  providerId: string;
  ws: WebSocket | null;
  createdAt: Date;
  output: string[];
  exited: boolean;
  exitCode: number | null;
  timeoutHandle?: NodeJS.Timeout;
  resolvedStatus?: "completed" | "failed";
}

const sessions = new Map<string, ApiSession>();
const completedOutput = new Map<string, { output: string; completedAt: number }>();

function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && ALLOWED_BROWSER_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function requestToken(req: http.IncomingMessage, url: URL): string | null {
  const authHeader = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  return getTokenFromAuthorizationHeader(authHeader) || url.searchParams.get("token");
}

function rejectUnauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

function stripAnsi(str: string): string {
  return str
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B[P^_][\s\S]*?\u001B\\/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, "");
}

function claudeIdlePromptVisible(output: string): boolean {
  const plain = stripAnsi(output).replace(/\r/g, "\n");
  return /(?:^|\n)[❯>]\s*$/.test(plain);
}

function transcriptShowsCompletedRun(output: string, prompt?: string): boolean {
  // Keep this prompt-aware. If we count placeholder SUMMARY/ARTIFACT lines from
  // the echoed startup prompt as "completed", the UI flips out of live terminal
  // mode after a few seconds and the session appears corrupted.
  const parsed = parseCabinetBlock(output, prompt);
  if (parsed.summary || parsed.artifactPaths.length > 0) {
    return true;
  }

  const plain = stripAnsi(output).replace(/\r/g, "\n");
  return (
    claudeIdlePromptVisible(plain)
  );
}

async function syncConversationChunk(sessionId: string, chunk: string): Promise<void> {
  const meta = await readConversationMeta(sessionId);
  if (!meta) return;
  const plainChunk = stripAnsi(chunk);
  if (!plainChunk) return;
  await appendConversationTranscript(sessionId, plainChunk);
}

async function finalizeSessionConversation(session: ApiSession): Promise<void> {
  const meta = await readConversationMeta(session.id);
  if (!meta) return;

  const plain = stripAnsi(session.output.join(""));
  if (meta.status !== "running") {
    completedOutput.set(session.id, { output: plain, completedAt: Date.now() });
    return;
  }
  await finalizeConversation(session.id, {
    status: session.resolvedStatus || (session.exitCode === 0 ? "completed" : "failed"),
    exitCode: session.resolvedStatus === "completed" ? 0 : session.exitCode,
    output: plain,
  });
}

// Cleanup old completed output every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, data] of completedOutput) {
    if (data.completedAt < cutoff) {
      completedOutput.delete(id);
    }
  }
}, 5 * 60 * 1000);

function createDetachedSession(input: {
  sessionId: string;
  providerId?: string;
  prompt?: string;
  cwd?: string;
  timeoutSeconds?: number;
  onData?: (chunk: string) => void;
}): ApiSession {
  const resolvedProviderId = resolveProviderId(input.providerId);
  const provider = providerRegistry.get(resolvedProviderId);

  const session: ApiSession = {
    id: input.sessionId,
    providerId: resolvedProviderId,
    ws: null,
    createdAt: new Date(),
    output: [],
    exited: false,
    exitCode: null,
  };
  sessions.set(input.sessionId, session);

  const pushChunk = (chunk: string): void => {
    session.output.push(chunk);
    void syncConversationChunk(input.sessionId, chunk).catch(() => {});
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(chunk);
    }
    input.onData?.(chunk);
  };

  const finalizeSession = (exitCode: number): void => {
    session.exited = true;
    session.exitCode = exitCode;
    if (session.timeoutHandle) {
      clearTimeout(session.timeoutHandle);
      delete session.timeoutHandle;
    }
    const plain = session.output.join("");
    completedOutput.set(input.sessionId, { output: plain, completedAt: Date.now() });
    void finalizeSessionConversation(session).catch(() => {});
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      sessions.delete(input.sessionId);
      session.ws.close();
    }
  };

  if (provider?.type === "api" && input.prompt) {
    const runApiSession = async (): Promise<void> => {
      try {
        if (provider.streamPrompt) {
          for await (const chunk of provider.streamPrompt(input.prompt!, "", input.sessionId)) {
            pushChunk(chunk);
          }
        } else if (provider.runPrompt) {
          const result = await provider.runPrompt(input.prompt!, "", input.sessionId);
          pushChunk(result);
        } else {
          throw new Error(`Provider ${resolvedProviderId} has no runPrompt or streamPrompt`);
        }
        finalizeSession(0);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        pushChunk(`\n[bodega-bridge] error: ${msg}\n`);
        finalizeSession(1);
      }
    };
    void runApiSession();
  }

  if (input.timeoutSeconds && input.timeoutSeconds > 0) {
    session.timeoutHandle = setTimeout(() => {
      console.warn(`Session ${input.sessionId} timed out after ${input.timeoutSeconds}s`);
      finalizeSession(1);
    }, input.timeoutSeconds * 1000);
  }

  return session;
}

// ===== WebSocket Event Bus =====

interface EventSubscriber {
  ws: WebSocket;
  channels: Set<string>;
}

const subscribers: EventSubscriber[] = [];

function broadcast(channel: string, data: Record<string, unknown>): void {
  const message = JSON.stringify({ channel, ...data });
  for (const sub of subscribers) {
    if (sub.channels.has(channel) || sub.channels.has("*")) {
      if (sub.ws.readyState === WebSocket.OPEN) {
        sub.ws.send(message);
      }
    }
  }
}

function handleEventBusConnection(ws: WebSocket): void {
  const subscriber: EventSubscriber = { ws, channels: new Set(["*"]) };
  subscribers.push(subscriber);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.subscribe) {
        subscriber.channels.add(msg.subscribe);
      }
      if (msg.unsubscribe) {
        subscriber.channels.delete(msg.unsubscribe);
      }
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    const idx = subscribers.indexOf(subscriber);
    if (idx >= 0) subscribers.splice(idx, 1);
  });
}

// ===== Job Scheduler =====

interface JobConfig {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  prompt: string;
  timeout?: number;
  agentSlug: string;
}

const scheduledJobs = new Map<string, ReturnType<typeof cron.schedule>>();
const scheduledHeartbeats = new Map<string, ReturnType<typeof cron.schedule>>();
let scheduleReloadTimer: NodeJS.Timeout | null = null;

async function putJson(url: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
}

function stopScheduledTasks(): void {
  for (const [, task] of scheduledJobs) task.stop();
  for (const [, task] of scheduledHeartbeats) task.stop();
  scheduledJobs.clear();
  scheduledHeartbeats.clear();
}

function scheduleJob(job: JobConfig): void {
  const key = `${job.agentSlug}/${job.id}`;
  const existingTask = scheduledJobs.get(key);
  if (existingTask) existingTask.stop();

  if (!cron.validate(job.schedule)) {
    console.warn(`Invalid cron schedule for job ${key}: ${job.schedule}`);
    return;
  }

  const task = cron.schedule(job.schedule, () => {
    console.log(`Triggering scheduled job ${key}`);
    void putJson(`${getAppOrigin()}/api/agents/${job.agentSlug}/jobs/${job.id}`, {
      action: "run",
      source: "scheduler",
    }).catch((error) => {
      console.error(`Failed to trigger scheduled job ${key}:`, error);
    });
  });

  scheduledJobs.set(key, task);
  console.log(`  Scheduled job: ${key} (${job.schedule})`);
}

function scheduleHeartbeat(slug: string, cronExpr: string): void {
  if (!cron.validate(cronExpr)) {
    console.warn(`Invalid heartbeat schedule for ${slug}: ${cronExpr}`);
    return;
  }

  const task = cron.schedule(cronExpr, () => {
    console.log(`Triggering heartbeat ${slug}`);
    void putJson(`${getAppOrigin()}/api/agents/personas/${slug}`, {
      action: "run",
      source: "scheduler",
    }).catch((error) => {
      console.error(`Failed to trigger heartbeat ${slug}:`, error);
    });
  });

  scheduledHeartbeats.set(slug, task);
  console.log(`  Scheduled heartbeat: ${slug} (${cronExpr})`);
}

async function reloadSchedules(): Promise<void> {
  stopScheduledTasks();

  if (!fs.existsSync(AGENTS_DIR)) return;

  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  let jobCount = 0;
  let heartbeatCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const personaPath = path.join(AGENTS_DIR, entry.name, "persona.md");
    if (fs.existsSync(personaPath)) {
      try {
        const rawPersona = fs.readFileSync(personaPath, "utf-8");
        const { data } = matter(rawPersona);
        const active = data.active !== false;
        const heartbeat = typeof data.heartbeat === "string" ? data.heartbeat : "";
        if (active && heartbeat) {
          scheduleHeartbeat(entry.name, heartbeat);
          heartbeatCount++;
        }
      } catch {
        // Skip malformed personas.
      }
    }

    const jobsDir = path.join(AGENTS_DIR, entry.name, "jobs");
    if (!fs.existsSync(jobsDir)) continue;

    const jobFiles = fs.readdirSync(jobsDir);
    for (const jf of jobFiles) {
      if (!jf.endsWith(".yaml")) continue;

      try {
        const raw = fs.readFileSync(path.join(jobsDir, jf), "utf-8");
        const config: JobConfig = {
          ...normalizeJobConfig(
            yaml.load(raw) as Partial<JobConfig>,
            entry.name,
            normalizeJobId(path.basename(jf, ".yaml"))
          ),
          agentSlug: entry.name,
        };
        if (config.id && config.enabled && config.schedule) {
          scheduleJob(config);
          jobCount++;
        }
      } catch {
        // Skip malformed jobs.
      }
    }
  }

  console.log(`Scheduled ${jobCount} jobs and ${heartbeatCount} heartbeats.`);
}

function queueScheduleReload(): void {
  if (scheduleReloadTimer) {
    clearTimeout(scheduleReloadTimer);
  }

  scheduleReloadTimer = setTimeout(() => {
    scheduleReloadTimer = null;
    void reloadSchedules().catch((error) => {
      console.error("Failed to reload daemon schedules:", error);
    });
  }, 200);
}

// ===== HTTP Server =====

const server = http.createServer(async (req, res) => {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "", `http://localhost:${PORT}`);
  if (url.pathname !== "/health" && !isDaemonTokenValid(requestToken(req, url))) {
    rejectUnauthorized(res);
    return;
  }

  // GET /session/:id/output — retrieve captured output for a completed session
  const outputMatch = url.pathname.match(/^\/session\/([^/]+)\/output$/);
  if (outputMatch && req.method === "GET") {
    const sessionId = outputMatch[1];

    const active = sessions.get(sessionId);
    if (active) {
      const raw = active.output.join("");
      const plain = stripAnsi(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          sessionId,
          status: active.resolvedStatus
            ? active.resolvedStatus
            : active.exited
              ? active.exitCode === 0
                ? "completed"
                : "failed"
              : "running",
          output: plain,
        })
      );
      return;
    }

    const conversationMeta = await readConversationMeta(sessionId).catch(() => null);
    if (conversationMeta) {
      const transcript = await readConversationTranscript(sessionId).catch(() => "");
      const plainTranscript = stripAnsi(transcript);
      let prompt = "";
      if (conversationMeta.promptPath) {
        const promptPath = path.join(DATA_DIR, conversationMeta.promptPath);
        if (fs.existsSync(promptPath)) {
          prompt = fs.readFileSync(promptPath, "utf8");
        }
      }
      if (
        conversationMeta.status === "running" &&
        transcriptShowsCompletedRun(plainTranscript, prompt)
      ) {
        await finalizeConversation(sessionId, {
          status: "completed",
          exitCode: 0,
          output: plainTranscript,
        }).catch(() => null);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            sessionId,
            status: "completed",
            output: plainTranscript,
          })
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          sessionId,
          status: conversationMeta.status,
          output: plainTranscript,
        })
      );
      return;
    }

    const completed = completedOutput.get(sessionId);
    if (completed) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessionId, status: "completed", output: completed.output }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Session not found" }));
    return;
  }

  // POST /sessions — create a PTY session without a WebSocket (for agent heartbeats)
  if (url.pathname === "/sessions" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const {
          id,
          providerId,
          prompt,
          cwd,
          timeoutSeconds,
        } = JSON.parse(body) as {
          id: string;
          providerId?: string;
          prompt?: string;
          cwd?: string;
          timeoutSeconds?: number;
        };
        const sessionId = id || `session-${Date.now()}`;

        if (sessions.has(sessionId)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sessionId, existing: true }));
          return;
        }

        try {
          createDetachedSession({
            sessionId,
            providerId,
            prompt,
            cwd,
            timeoutSeconds,
          });
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMsg }));
          return;
        }

        console.log(`Session ${sessionId} started via HTTP (agent mode)`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessionId }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  // GET /sessions — list all active sessions
  if (url.pathname === "/sessions" && req.method === "GET") {
    const activeSessions = Array.from(sessions.values()).map((s) => ({
      id: s.id,
      createdAt: s.createdAt.toISOString(),
      connected: s.ws !== null,
      exited: s.exited,
      exitCode: s.exitCode,
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(activeSessions));
    return;
  }

  if (url.pathname === "/reload-schedules" && req.method === "POST") {
    try {
      await reloadSchedules();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          jobs: scheduledJobs.size,
          heartbeats: scheduledHeartbeats.size,
        })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        activeSessions: sessions.size,
        scheduledJobs: scheduledJobs.size,
        scheduledHeartbeats: scheduledHeartbeats.size,
        subscribers: subscribers.length,
      })
    );
    return;
  }

  // Trigger job manually
  if (url.pathname === "/trigger" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { agentSlug, jobId, prompt, providerId, timeoutSeconds } = JSON.parse(body);
        if (prompt) {
          const sessionId = jobId || `manual-${Date.now()}`;
          createDetachedSession({
            sessionId,
            providerId,
            prompt,
            timeoutSeconds,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessionId, agentSlug: agentSlug || "manual" }));
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "prompt is required" }));
        }
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// ===== WebSocket Server =====

// Event bus WebSocket — /events path
const wssEvents = new WebSocketServer({ noServer: true });

// Route WebSocket upgrades
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "", `http://localhost:${PORT}`);
  if (!isDaemonTokenValid(requestToken(req, url))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  if (url.pathname === "/events" || url.pathname === "/api/daemon/events") {
    wssEvents.handleUpgrade(req, socket, head, (ws) => {
      wssEvents.emit("connection", ws, req);
    });
  } else {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});

wssEvents.on("connection", (ws) => {
  handleEventBusConnection(ws);
});

// ===== Startup =====

const scheduleWatcher = chokidar.watch(
  [path.join(AGENTS_DIR, "*/persona.md"), path.join(AGENTS_DIR, "*/jobs/*.yaml")],
  {
    ignoreInitial: true,
  }
);

scheduleWatcher.on("all", () => {
  queueScheduleReload();
});

server.listen(PORT, () => {
  console.log(`Cabinet Daemon running on port ${PORT}`);
  console.log(`  Events WebSocket: ws://localhost:${PORT}/api/daemon/events`);
  console.log(`  Session API: http://localhost:${PORT}/sessions`);
  console.log(`  Reload schedules: POST http://localhost:${PORT}/reload-schedules`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log(`  Trigger endpoint: POST http://localhost:${PORT}/trigger`);
  console.log(`  Default provider: ${resolveProviderId()}`);
  console.log(`  Working directory: ${DATA_DIR}`);

  void reloadSchedules();
});

// ===== Graceful Shutdown =====

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  for (const [, task] of scheduledJobs) {
    task.stop();
  }
  for (const [, task] of scheduledHeartbeats) {
    task.stop();
  }
  void scheduleWatcher.close();
  closeDb();
  server.close();
  process.exit(0);
});

wssEvents.on("error", (err) => {
  console.error("Events WebSocket error:", err.message);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
