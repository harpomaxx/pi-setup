import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const API_BASE = "https://workflowy.com/api/v1";

function getApiKey(): string | undefined {
	return process.env.WORKFLOWY_API_KEY;
}

function formatNode(node: Record<string, unknown>): string {
	const name = typeof node.name === "string" ? node.name : "(unnamed)";
	const id = typeof node.id === "string" ? node.id : "(no id)";
	const note = typeof node.note === "string" ? node.note : null;
	const priority = typeof node.priority === "number" ? node.priority : "?";
	const completedAt = node.completedAt ?? null;
	const createdAt = typeof node.createdAt === "number"
		? new Date(node.createdAt * 1000).toISOString()
		: "?";
	const layoutMode = (node.data as Record<string, unknown> | undefined)?.layoutMode ?? "bullets";

	let text = `- ${name}\n  ID: ${id}\n  Priority: ${priority}\n  Layout: ${layoutMode}\n  Created: ${createdAt}`;
	if (note) text += `\n  Note: ${note}`;
	if (completedAt) text += `\n  Completed: ${new Date((completedAt as number) * 1000).toISOString()}`;
	return text;
}

function formatNodeInline(node: Record<string, unknown>): string {
	const name = typeof node.name === "string" ? node.name : "(unnamed)";
	const id = typeof node.id === "string" ? node.id : "";
	return `- ${name}\n  ID: ${id}`;
}

async function wfRequest(
	method: string,
	path: string,
	body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const key = getApiKey();
	if (!key) {
		throw new Error("WORKFLOWY_API_KEY is not set. Export it before starting Pi.");
	}

	const url = `${API_BASE}${path}`;
	const options: RequestInit = {
		method,
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
	};
	if (body) options.body = JSON.stringify(body);

	const res = await fetch(url, options);

	let data: Record<string, unknown> = {};
	const text = await res.text();
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			throw new Error(`Workflowy returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
		}
	}

	if (!res.ok) {
		const msg = typeof data.error === "string" ? data.error : text;
		if (res.status === 401) throw new Error("Invalid API key (401). Check WORKFLOWY_API_KEY.");
		if (res.status === 404) throw new Error(`Not found (404). ${msg || "Check node ID or target key."}`);
		if (res.status === 429) throw new Error("Rate limited (429). Please wait before retrying.");
		throw new Error(`Workflowy API error (${res.status}): ${msg || res.statusText}`);
	}

	return data;
}

function truncateOutput(text: string, maxLines = 200, maxChars = 8000): string {
	if (text.length > maxChars) text = text.slice(0, maxChars) + "\n... [truncated]";
	const lines = text.split("\n");
	if (lines.length > maxLines) return lines.slice(0, maxLines).join("\n") + "\n... [truncated]";
	return text;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDateKey(d: Date): string {
	const year = d.getFullYear();
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function parseDate(dateStr: string): Date {
	const [year, month, day] = dateStr.split("-").map(Number);
	return new Date(year, month - 1, day);
}

function addDays(d: Date, days: number): Date {
	const result = new Date(d);
	result.setDate(result.getDate() + days);
	return result;
}

export default function (pi: ExtensionAPI) {
	// ─── workflowy_create ────────────────────────────────────────────
	pi.registerTool({
		name: "workflowy_create",
		label: "Workflowy Create Node",
		description:
			"Create a new node in Workflowy. Add items to a specific parent (e.g., 'inbox') or as a top-level node. Supports markdown formatting in the name and layout modes.",
		promptSnippet: "Create a new bullet/todo in Workflowy",
		promptGuidelines: [
			"Use workflowy_create when the user wants to add a new item, task, note, or bullet to their Workflowy outline.",
			"Default parent_id is 'inbox' if the user does not specify a location.",
			"Create normal bullet nodes by default. Do not create checkbox/TODO nodes, do not set layoutMode='todo', and do not include markdown checkboxes like [ ] unless the user explicitly asks for a TODO/task/checkbox.",
			"The name field supports markdown: **bold**, *italic*, # headers, links [text](url), dates [YYYY-MM-DD], and explicit TODO checkboxes only when requested.",
			"Use double newlines (\\n\\n) in name to create child nodes under the first line.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Text content of the node. Supports markdown formatting." }),
			parent_id: Type.Optional(
				Type.String({ description: "Parent node ID, target key (e.g., 'inbox', 'home'), or 'None' for top-level. Defaults to 'inbox'." }),
			),
			note: Type.Optional(Type.String({ description: "Additional note content below the main bullet." })),
			position: Type.Optional(
				Type.String({ description: "Where to place: 'top' (default) or 'bottom'." }),
			),
			layoutMode: Type.Optional(
				Type.String({ description: "Display mode: 'bullets', 'todo', 'h1', 'h2', 'h3', 'code-block', 'quote-block'. Default to bullets; use 'todo' only when the user explicitly asks for a TODO/task/checkbox." }),
			),
		}),

		async execute(_toolCallId, params) {
			const payload: Record<string, unknown> = {
				parent_id: params.parent_id ?? "inbox",
				name: params.name,
			};
			if (params.note) payload.note = params.note;
			if (params.position) payload.position = params.position;
			if (params.layoutMode) payload.layoutMode = params.layoutMode;

			const data = await wfRequest("POST", "/nodes", payload);
			const itemId = typeof data.item_id === "string" ? data.item_id : "?";

			return {
				content: [{
					type: "text",
					text: `Created Workflowy node.\nID: ${itemId}\nParent: ${payload.parent_id}\nName: ${params.name}`,
				}],
				details: { item_id: itemId },
			};
		},
	});

	// ─── workflowy_get ───────────────────────────────────────────────
	pi.registerTool({
		name: "workflowy_get",
		label: "Workflowy Get Node",
		description:
			"Retrieve a single Workflowy node by its ID. Returns full metadata including name, note, priority, layout mode, timestamps, and completion status.",
		promptSnippet: "Fetch details of a specific Workflowy node",
		promptGuidelines: [
			"Use workflowy_get when the user asks about a specific node or wants to verify its contents.",
			"The node ID is required. If the user refers to a node ambiguously, ask for the ID or use workflowy_list first.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "The unique node UUID or target key." }),
		}),

		async execute(_toolCallId, params) {
			const data = await wfRequest("GET", `/nodes/${encodeURIComponent(params.id)}`);
			const node = (data.node as Record<string, unknown>) ?? {};

			return {
				content: [{
					type: "text",
					text: `Workflowy Node:\n${formatNode(node)}`,
				}],
				details: { node },
			};
		},
	});

	// ─── workflowy_list ──────────────────────────────────────────────
	pi.registerTool({
		name: "workflowy_list",
		label: "Workflowy List Nodes",
		description:
			"List child nodes of a parent in Workflowy. Returns an unordered list — sort by the 'priority' field to display in order.",
		promptSnippet: "List items under a Workflowy node or target",
		promptGuidelines: [
			"Use workflowy_list when the user asks to see items under a specific node, inbox, or target.",
			"Default parent_id is 'inbox'. Use 'None' for top-level nodes.",
			"Results are unordered. Sort by the 'priority' field for the correct display order.",
		],
		parameters: Type.Object({
			parent_id: Type.Optional(
				Type.String({ description: "Parent node ID or target key (e.g., 'inbox'). Defaults to 'inbox'. Use 'None' for top-level." }),
			),
		}),

		async execute(_toolCallId, params) {
			const parentId = params.parent_id ?? "inbox";
			const data = await wfRequest("GET", `/nodes?parent_id=${encodeURIComponent(parentId)}`);
			const nodes = data.nodes as Record<string, unknown>[] | undefined;

			if (!nodes || nodes.length === 0) {
				return {
					content: [{
						type: "text",
						text: `No nodes found under "${parentId}".`,
					}],
					details: { parent_id: parentId, count: 0 },
				};
			}

			const sorted = [...nodes].sort((a, b) => {
				const pa = typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER;
				const pb = typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER;
				return pa - pb;
			});

			const lines = [`Nodes under "${parentId}" (${nodes.length} total):`, ""];
			for (const n of sorted) {
				lines.push(formatNodeInline(n));
			}

			return {
				content: [{
					type: "text",
					text: truncateOutput(lines.join("\n")),
				}],
				details: { parent_id: parentId, count: nodes.length, nodes: sorted },
			};
		},
	});

	// ─── workflowy_update ────────────────────────────────────────────
	pi.registerTool({
		name: "workflowy_update",
		label: "Workflowy Update Node",
		description:
			"Update an existing Workflowy node's name, note, or layout mode. Only specified fields are changed.",
		promptSnippet: "Edit a Workflowy node's text or metadata",
		promptGuidelines: [
			"Use workflowy_update when the user wants to change the text, note, or appearance of an existing Workflowy node.",
			"Only pass the fields you want to change. Missing fields are left unchanged.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Node UUID to update." }),
			name: Type.Optional(Type.String({ description: "New text content (markdown supported)." })),
			note: Type.Optional(Type.String({ description: "New note content." })),
			layoutMode: Type.Optional(Type.String({ description: "New display mode." })),
		}),

		async execute(_toolCallId, params) {
			const payload: Record<string, unknown> = {};
			if (params.name !== undefined) payload.name = params.name;
			if (params.note !== undefined) payload.note = params.note;
			if (params.layoutMode !== undefined) payload.layoutMode = params.layoutMode;

			const data = await wfRequest("POST", `/nodes/${encodeURIComponent(params.id)}`, payload);

			return {
				content: [{
					type: "text",
					text: `Updated node ${params.id}.\nStatus: ${typeof data.status === "string" ? data.status : "ok"}`,
				}],
				details: { id: params.id, ...payload, status: data.status },
			};
		},
	});

	// ─── workflowy_complete ──────────────────────────────────────────
	pi.registerTool({
		name: "workflowy_complete",
		label: "Workflowy Complete Node",
		description:
			"Mark a Workflowy node as completed or uncompleted.",
		promptSnippet: "Mark a Workflowy todo/item as done or undone",
		promptGuidelines: [
			"Use workflowy_complete when the user wants to mark a task/item as done or not done in Workflowy.",
		],
		parameters: Type.Object({
			id: Type.String({ description: "Node UUID." }),
			complete: Type.Boolean({ description: "true to complete, false to uncomplete." }),
		}),

		async execute(_toolCallId, params) {
			const action = params.complete ? "complete" : "uncomplete";
			const data = await wfRequest("POST", `/nodes/${encodeURIComponent(params.id)}/${action}`);

			return {
				content: [{
					type: "text",
					text: `${params.complete ? "Completed" : "Uncompleted"} node ${params.id}.\nStatus: ${typeof data.status === "string" ? data.status : "ok"}`,
				}],
				details: { id: params.id, complete: params.complete, status: data.status },
			};
		},
	});

	// ─── workflowy_targets ───────────────────────────────────────────
	pi.registerTool({
		name: "workflowy_targets",
		label: "Workflowy List Targets",
		description:
			"List all available Workflowy targets (shortcuts like 'home', 'inbox', 'today'). Useful for finding valid parent_id values.",
		promptSnippet: "Show Workflowy target shortcuts",
		promptGuidelines: [
			"Use workflowy_targets when you need to know the available target keys a user can reference.",
			"Targets include system targets (like 'inbox') and user-defined shortcuts (like 'home').",
		],
		parameters: Type.Object({}),

		async execute() {
			const data = await wfRequest("GET", "/targets");
			const targets = data.targets as Record<string, unknown>[] | undefined;

			if (!targets || targets.length === 0) {
				return {
					content: [{ type: "text", text: "No targets found." }],
					details: { count: 0 },
				};
			}

			const lines = ["Workflowy Targets:", ""];
			for (const t of targets) {
				const key = typeof t.key === "string" ? t.key : "?";
				const type = typeof t.type === "string" ? t.type : "?";
				const name = typeof t.name === "string" ? t.name : "(not created yet)";
				lines.push(`- ${key} (${type}) → ${name}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { targets },
			};
		},
	});

	// ─── workflowy_list_calendar ───────────────────────────────────
	pi.registerTool({
		name: "workflowy_list_calendar",
		label: "Workflowy List Calendar",
		description:
			"List scheduled Workflowy items across a date range by querying each day's calendar node. Aggregates results from all days in the range.",
		promptSnippet: "List Workflowy calendar items across a date range",
		promptGuidelines: [
			"Use workflowy_list_calendar when the user wants to see scheduled tasks or items from their Workflowy calendar across multiple days.",
			"Dates must be in YYYY-MM-DD format.",
			"The maximum range is 31 days to avoid rate limits.",
			"Calendar days that haven't been created yet return no items.",
		],
		parameters: Type.Object({
			start_date: Type.Optional(Type.String({ description: "Start date in YYYY-MM-DD format. Defaults to today." })),
			end_date: Type.Optional(Type.String({ description: "End date in YYYY-MM-DD format. Defaults to start_date (single day)." })),
			include_completed: Type.Optional(Type.Boolean({ description: "Whether to include completed items. Defaults to true." })),
		}),

		async execute(_toolCallId, params) {
			const today = formatDateKey(new Date());
			const start = params.start_date ?? today;
			const end = params.end_date ?? start;
			const maxRange = 31;

			const startDate = parseDate(start);
			const endDate = parseDate(end);

			if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
				throw new Error("Invalid date format. Use YYYY-MM-DD.");
			}

			if (startDate > endDate) {
				throw new Error("start_date must be before or equal to end_date.");
			}

			const dayCount = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;
			if (dayCount > maxRange) {
				throw new Error(`Date range too large (${dayCount} days). Maximum is ${maxRange} days.`);
			}

			const includeCompleted = params.include_completed !== false;
			const results: Array<{ date: string; node: Record<string, unknown> }> = [];

			for (let i = 0; i < dayCount; i++) {
				const current = addDays(startDate, i);
				const dateKey = formatDateKey(current);

				try {
					const data = await wfRequest("GET", `/nodes?parent_id=${encodeURIComponent(dateKey)}`);
					const nodes = data.nodes as Record<string, unknown>[] | undefined;
					if (nodes) {
						for (const node of nodes) {
							if (!includeCompleted && node.completedAt) continue;
							results.push({ date: dateKey, node });
						}
					}
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					if (msg.includes("404")) {
						// No calendar node for this day yet, skip silently
						continue;
					}
					throw err;
				}

				// Small polite delay between requests
				if (i < dayCount - 1) await sleep(200);
			}

			// Sort by date, then by priority
			results.sort((a, b) => {
				if (a.date !== b.date) return a.date.localeCompare(b.date);
				const pa = typeof a.node.priority === "number" ? a.node.priority : Number.MAX_SAFE_INTEGER;
				const pb = typeof b.node.priority === "number" ? b.node.priority : Number.MAX_SAFE_INTEGER;
				return pa - pb;
			});

			if (results.length === 0) {
				return {
					content: [{
						type: "text",
						text: `No calendar items found between ${start} and ${end}.`,
					}],
					details: { start_date: start, end_date: end, count: 0 },
				};
			}

			const lines = [`Calendar items from ${start} to ${end} (${results.length} total):`, ""];
			let lastDate = "";
			for (const { date, node } of results) {
				if (date !== lastDate) {
					lines.push(`## ${date}`);
					lastDate = date;
				}
				lines.push(`  ${formatNodeInline(node)}`);
				const note = typeof node.note === "string" ? node.note : null;
				if (note) lines.push(`    Note: ${note}`);
				if (node.completedAt) lines.push(`    ✅ Completed`);
			}

			return {
				content: [{
					type: "text",
					text: truncateOutput(lines.join("\n")),
				}],
				details: { start_date: start, end_date: end, count: results.length, items: results },
			};
		},
	});

	// ─── /workflowy (status) ─────────────────────────────────────────
	pi.registerCommand("workflowy", {
		description: "Show Workflowy extension status and available targets",
		handler: async (_args, ctx) => {
			const key = getApiKey();
			if (!key) {
				if (ctx.hasUI) ctx.ui.notify("WORKFLOWY_API_KEY is not set. Export it and restart Pi.", "error");
				return;
			}
			try {
				const data = await wfRequest("GET", "/targets");
				const targets = data.targets as Record<string, unknown>[] | undefined;
				const lines = [
					"✅ Workflowy API connected.",
					"",
					`API key: ${key.slice(0, 6)}...`,
					"",
					`Targets (${targets?.length ?? 0}):`,
				];
				if (targets) {
					for (const t of targets) {
						const keyName = typeof t.key === "string" ? t.key : "?";
						const type = typeof t.type === "string" ? t.type : "?";
						const name = typeof t.name === "string" ? t.name : "(not created yet)";
						lines.push(`  - ${keyName} (${type}) → ${name}`);
					}
				}
				if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (ctx.hasUI) ctx.ui.notify(`Workflowy check failed: ${msg}`, "error");
			}
		},
	});

	// ─── /workflowy-export ───────────────────────────────────────────
	pi.registerCommand("workflowy-export", {
		description: "Export all Workflowy nodes as a flat list (rate limit: 1 req/min)",
		handler: async (_args, ctx) => {
			const key = getApiKey();
			if (!key) {
				if (ctx.hasUI) ctx.ui.notify("WORKFLOWY_API_KEY is not set. Export it and restart Pi.", "error");
				return;
			}
			if (ctx.hasUI) ctx.ui.notify("Exporting all Workflowy nodes... (rate limit: 1/min)", "info");
			try {
				const data = await wfRequest("GET", "/nodes-export");
				const nodes = data.nodes as Record<string, unknown>[] | undefined;
				const count = nodes?.length ?? 0;
				if (ctx.hasUI) ctx.ui.notify(`Exported ${count} nodes. Full data in context.`, "info");
				// Also return as text so it shows up in the session
				console.log(`[workflowy-export] ${count} nodes exported`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (ctx.hasUI) ctx.ui.notify(`Export failed: ${msg}`, "error");
			}
		},
	});
}
