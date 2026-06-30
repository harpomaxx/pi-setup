/**
 * remote-monitor.ts
 *
 * Opens an HTTP server inside a running Pi session so a browser can
 * observe and steer the agent in real time, including approval dialogs.
 *
 * Endpoints (default port 3141, override with MONITOR_PORT env var):
 *   GET  /          → monitor UI (ui.html, one dir up from extensions/)
 *   GET  /health    → {"ok":true,"isStreaming":bool}
 *   GET  /state     → session state snapshot
 *   GET  /messages  → conversation history
 *   GET  /events    → SSE stream of all Pi events
 *   POST /prompt    → {"message":"..."} send or steer
 *   POST /steer     → {"message":"..."} queue steering message
 *   POST /followup  → {"message":"..."} queue follow-up
 *   POST /abort     → abort current run
 *   POST /approve   → {"id":"...","choice":"Allow once"|"Always allow tool"|"Deny"} answer approval
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";

const PORT = parseInt(process.env.MONITOR_PORT ?? "3141", 10);
const UI_FILE = path.join(__dirname, "..", "ui.html");

// Approval choices shown in the browser
const APPROVAL_OPTIONS = ["Allow once", "Always allow tool this session", "Deny"] as const;
type ApprovalChoice = typeof APPROVAL_OPTIONS[number];

export default function (pi: ExtensionAPI) {
  // ── State ─────────────────────────────────────────────────────────────────
  let latestCtx: ExtensionContext | undefined;
  let isStreaming = false;

  // Pending approval requests waiting for browser response
  // id → { resolve, toolName, summary, details }
  const pendingApprovals = new Map<string, {
    resolve: (choice: ApprovalChoice) => void;
    toolName: string;
    summary: string;
    details: string;
  }>();

  // Tools always-allowed this session (set via browser approval)
  const allowedTools = new Set<string>();

  let approvalCounter = 0;

  // ── SSE clients ───────────────────────────────────────────────────────────
  const sseClients: http.ServerResponse[] = [];

  function broadcast(payload: unknown) {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch { /* disconnected */ }
    }
  }

  const hasBrowserConnected = () => sseClients.length > 0;

  // ── Tool call approval helpers ────────────────────────────────────────────
  function describeTool(toolName: string, input: Record<string, unknown>): { summary: string; details: string } {
    let summary = toolName;
    let details = JSON.stringify(input, null, 2);

    if (toolName === "bash" && typeof input.command === "string") {
      summary = `bash: ${(input.command as string).split("\n")[0].slice(0, 80)}`;
      details = input.command as string;
    } else if ((toolName === "write" || toolName === "edit" || toolName === "read") && typeof input.path === "string") {
      summary = `${toolName}: ${input.path}`;
    }
    return { summary, details };
  }

  // ── Pi event forwarding ───────────────────────────────────────────────────
  function handle(type: string) {
    return async (event: unknown, ctx: ExtensionContext) => {
      latestCtx = ctx;
      broadcast({ type, ...(typeof event === "object" && event !== null ? event : {}) });
    };
  }

  pi.on("before_agent_start", async (ev, ctx) => {
    latestCtx = ctx;
    broadcast({ type: "user_message", message: ev.prompt, timestamp: Date.now() });
  });

  pi.on("agent_start",          async (_ev, ctx) => { latestCtx = ctx; isStreaming = true;  broadcast({ type: "agent_start" }); });
  pi.on("agent_end",            async (ev,  ctx) => { latestCtx = ctx; isStreaming = false; broadcast({ type: "agent_end", messages: ev.messages }); });
  pi.on("turn_start",           handle("turn_start"));
  pi.on("turn_end",             handle("turn_end"));
  pi.on("message_start",        handle("message_start"));
  pi.on("message_update",       handle("message_update"));
  pi.on("message_end",          handle("message_end"));
  pi.on("tool_execution_start", handle("tool_execution_start"));
  pi.on("tool_execution_update",handle("tool_execution_update"));
  pi.on("tool_execution_end",   handle("tool_execution_end"));
  pi.on("session_before_compact", handle("compaction_start"));
  pi.on("session_compact",        handle("compaction_end"));

  // ── Tool call approval (intercepts before approval-gate when browser is open) ──
  pi.on("tool_call", async (event, ctx) => {
    latestCtx = ctx;
    const input = event.input as Record<string, unknown>;
    const mutating = new Set(["bash", "write", "edit"]);

    // Only gate mutating tools, same default as approval-gate
    if (!mutating.has(event.toolName)) return undefined;
    // Already allowed this session
    if (allowedTools.has(event.toolName)) return undefined;
    // No browser connected — let approval-gate handle it in TUI
    if (!hasBrowserConnected()) return undefined;

    const { summary, details } = describeTool(event.toolName, input);
    const id = `approval-${++approvalCounter}`;

    // Send approval request to browser via SSE
    broadcast({
      type: "approval_request",
      id,
      toolName: event.toolName,
      summary,
      details,
      options: APPROVAL_OPTIONS,
    });

    // Wait for browser response (30s timeout → deny)
    const choice = await new Promise<ApprovalChoice>((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(id);
        broadcast({ type: "approval_timeout", id });
        resolve("Deny");
      }, 30_000);

      pendingApprovals.set(id, {
        resolve: (c) => { clearTimeout(timer); resolve(c); },
        toolName: event.toolName,
        summary,
        details,
      });
    });

    broadcast({ type: "approval_resolved", id, choice });

    if (choice === "Always allow tool this session") {
      allowedTools.add(event.toolName);
      return undefined; // allow
    }
    if (choice === "Allow once") return undefined;
    return { block: true, reason: `Denied via remote monitor` };
  });

  // ── HTTP helpers ──────────────────────────────────────────────────────────
  function sendJson(res: http.ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(data));
  }
  function sendError(res: http.ServerResponse, status: number, msg: string) {
    sendJson(res, status, { error: msg });
  }
  function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch { reject(new Error("Invalid JSON body")); }
      });
    });
  }

  // ── HTTP server ───────────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const url      = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method   = req.method ?? "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
      return res.end();
    }

    try {
      if (method === "GET" && (pathname === "/" || pathname === "/ui")) {
        try {
          const html = fs.readFileSync(UI_FILE, "utf8");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          return res.end(html);
        } catch {
          return sendError(res, 404, "ui.html not found");
        }
      }

      if (method === "GET" && pathname === "/health") {
        return sendJson(res, 200, { ok: true, isStreaming });
      }

      if (method === "GET" && pathname === "/state") {
        const ctx = latestCtx;
        if (!ctx) return sendJson(res, 200, { isStreaming, model: null, messageCount: 0 });
        return sendJson(res, 200, {
          isStreaming,
          model: ctx.model ?? null,
          thinkingLevel: pi.getThinkingLevel(),
          messageCount: ctx.sessionManager.getPath().length,
          cwd: ctx.cwd,
          contextUsage: ctx.getContextUsage() ?? null,
        });
      }

      if (method === "GET" && pathname === "/messages") {
        const ctx = latestCtx;
        if (!ctx) return sendJson(res, 200, { messages: [] });
        return sendJson(res, 200, { messages: ctx.sessionManager.getPath() });
      }

      if (method === "GET" && pathname === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write(": connected\n\n");
        sseClients.push(res);
        req.on("close", () => {
          const i = sseClients.indexOf(res);
          if (i !== -1) sseClients.splice(i, 1);
        });
        return;
      }

      if (method === "POST" && pathname === "/prompt") {
        const body = await readBody(req);
        const message = body.message as string;
        if (!message) return sendError(res, 400, "message is required");
        pi.sendUserMessage(message, isStreaming ? { deliverAs: "steer" } : undefined);
        return sendJson(res, 200, { ok: true, deliveredAs: isStreaming ? "steer" : "prompt" });
      }

      if (method === "POST" && pathname === "/steer") {
        const body = await readBody(req);
        const message = body.message as string;
        if (!message) return sendError(res, 400, "message is required");
        pi.sendUserMessage(message, { deliverAs: "steer" });
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/followup") {
        const body = await readBody(req);
        const message = body.message as string;
        if (!message) return sendError(res, 400, "message is required");
        pi.sendUserMessage(message, { deliverAs: "followUp" });
        return sendJson(res, 200, { ok: true });
      }

      if (method === "POST" && pathname === "/abort") {
        if (latestCtx) latestCtx.abort();
        return sendJson(res, 200, { ok: true });
      }

      // POST /approve  — browser answers a pending approval dialog
      if (method === "POST" && pathname === "/approve") {
        const body = await readBody(req);
        const id     = body.id as string;
        const choice = body.choice as ApprovalChoice;
        if (!id || !APPROVAL_OPTIONS.includes(choice)) {
          return sendError(res, 400, "id and choice required");
        }
        const pending = pendingApprovals.get(id);
        if (!pending) return sendError(res, 404, "approval request not found or already resolved");
        pendingApprovals.delete(id);
        pending.resolve(choice);
        return sendJson(res, 200, { ok: true });
      }

      sendError(res, 404, "Not found");
    } catch (e: any) {
      sendError(res, 500, e?.message ?? "Internal error");
    }
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.error(`[remote-monitor] Listening on http://localhost:${PORT}`);
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(`[remote-monitor] Port ${PORT} in use — set MONITOR_PORT to override`);
    } else {
      console.error(`[remote-monitor] Error:`, e.message);
    }
  });

  pi.on("session_start", async (_ev, ctx) => {
    latestCtx = ctx;
    ctx.ui.notify(`Remote monitor → http://localhost:${PORT}`, "info");
  });
}
