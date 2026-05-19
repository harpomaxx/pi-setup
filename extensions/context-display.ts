/**
 * Context Display Extension
 *
 * Overrides /context with an on-demand, Claude-style context usage report.
 * It does not add anything to the footer/status line; stats are shown only
 * when the user runs /context.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type UsageLike = {
	tokens: number | null;
	contextWindow?: number;
	percent?: number | null;
};

type Segment = {
	key: "system" | "tools" | "messages" | "free";
	label: string;
	tokens: number;
	color: "accent" | "success" | "warning" | "error" | "muted" | "dim";
	glyph: string;
};

type ToolBreakdown = {
	name: string;
	tokens: number;
	source: string;
};

type Snapshot = {
	contextWindow: number;
	used: number | null;
	percent: number | null;
	segments: Segment[];
	messageCount: number;
	userMessages: number;
	assistantMessages: number;
	toolResults: number;
	lastInput: number;
	lastOutput: number;
	sessionInput: number;
	sessionOutput: number;
	sessionCost: number;
	model: string;
	tools: ToolBreakdown[];
	activeToolCount: number;
};

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function estimateTokens(value: unknown): number {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
	// Good enough for a visual breakdown. We scale estimates to Pi's actual total
	// context usage when that value is available.
	return Math.max(1, Math.ceil(text.length / 4));
}

function formatTokens(value: number | null | undefined): string {
	if (value == null) return "unknown";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 10_000) return `${Math.round(value / 1_000)}K`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return value.toLocaleString();
}

function formatMoney(value: number): string {
	if (!value) return "$0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

function pct(part: number, total: number): string {
	if (!total) return "0.0%";
	return `${((part / total) * 100).toFixed(1)}%`;
}

function pctColor(percent: number | null): "success" | "warning" | "error" | "accent" {
	if (percent == null) return "accent";
	if (percent < 70) return "success";
	if (percent < 90) return "warning";
	return "error";
}

function sourceLabel(sourceInfo: unknown): string {
	const source = sourceInfo as { source?: string; path?: string; scope?: string } | undefined;
	return source?.source ?? source?.scope ?? source?.path ?? "tool";
}

function getMessage(entry: unknown): any | undefined {
	const e = entry as { type?: string; message?: unknown };
	return e.type === "message" ? e.message : undefined;
}

function makeBlockGrid(segments: Segment[], total: number, color: (name: string, text: string) => string): string[] {
	const cells = 50;
	const rows = 5;
	const cols = Math.ceil(cells / rows);
	let emitted = 0;
	const rawCells: Array<{ color: string; glyph: string }> = [];
	const usableTotal = total || segments.reduce((sum, s) => sum + s.tokens, 0) || 1;

	for (const segment of segments) {
		const count = Math.max(segment.tokens > 0 ? 1 : 0, Math.round((segment.tokens / usableTotal) * cells));
		for (let i = 0; i < count && emitted < cells; i++) {
			rawCells.push({ color: segment.color, glyph: segment.glyph });
			emitted++;
		}
	}
	while (emitted++ < cells) rawCells.push({ color: "dim", glyph: "░" });

	const lines: string[] = [];
	for (let row = 0; row < rows; row++) {
		const chunk = rawCells.slice(row * cols, (row + 1) * cols).map((cell) => color(cell.color, cell.glyph)).join("");
		lines.push(`  ${chunk}`);
	}
	return lines;
}

function scaleToTotal(parts: { system: number; tools: number; messages: number }, used: number | null) {
	if (used == null) return parts;
	const estimated = parts.system + parts.tools + parts.messages;
	if (!estimated) return parts;
	const factor = used / estimated;
	return {
		system: Math.max(0, Math.round(parts.system * factor)),
		tools: Math.max(0, Math.round(parts.tools * factor)),
		messages: Math.max(0, used - Math.round(parts.system * factor) - Math.round(parts.tools * factor)),
	};
}

function buildSnapshot(pi: ExtensionAPI, ctx: Parameters<NonNullable<ExtensionAPI["on"]>>[1]): Snapshot {
	const usage = ctx.getContextUsage() as UsageLike | undefined;
	const model = ctx.model as any;
	const contextWindow = usage?.contextWindow ?? numberOrZero(model?.contextWindow);
	const used = usage?.tokens ?? null;
	const percent = usage?.percent ?? (used != null && contextWindow ? (used / contextWindow) * 100 : null);

	let userMessages = 0;
	let assistantMessages = 0;
	let toolResults = 0;
	let lastInput = 0;
	let lastOutput = 0;
	let sessionInput = 0;
	let sessionOutput = 0;
	let sessionCost = 0;
	let messageEstimate = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		const message = getMessage(entry);
		if (!message) continue;

		messageEstimate += estimateTokens(message);
		if (message.role === "user") userMessages++;
		else if (message.role === "assistant") {
			assistantMessages++;
			const u = message.usage ?? {};
			lastInput = numberOrZero(u.input);
			lastOutput = numberOrZero(u.output);
			sessionInput += lastInput;
			sessionOutput += lastOutput;
			sessionCost += numberOrZero(u.cost?.total);
		} else if (message.role === "toolResult") toolResults++;
	}

	const active = new Set(pi.getActiveTools());
	const tools = pi
		.getAllTools()
		.filter((tool) => active.has(tool.name))
		.map((tool) => ({
			name: tool.name,
			tokens: estimateTokens({ name: tool.name, description: tool.description, parameters: tool.parameters }),
			source: sourceLabel(tool.sourceInfo),
		}))
		.sort((a, b) => b.tokens - a.tokens);

	const systemEstimate = estimateTokens(ctx.getSystemPrompt());
	const toolEstimate = tools.reduce((sum, tool) => sum + tool.tokens, 0);
	const scaled = scaleToTotal({ system: systemEstimate, tools: toolEstimate, messages: messageEstimate }, used);
	const free = used != null && contextWindow ? Math.max(contextWindow - used, 0) : 0;

	return {
		contextWindow,
		used,
		percent,
		segments: [
			{ key: "system", label: "System prompt", tokens: scaled.system, color: "muted", glyph: "■" },
			{ key: "tools", label: "Tools", tokens: scaled.tools, color: "accent", glyph: "■" },
			{ key: "messages", label: "Messages", tokens: scaled.messages, color: "warning", glyph: "■" },
			{ key: "free", label: "Free space", tokens: free, color: "dim", glyph: "□" },
		],
		messageCount: userMessages + assistantMessages + toolResults,
		userMessages,
		assistantMessages,
		toolResults,
		lastInput,
		lastOutput,
		sessionInput,
		sessionOutput,
		sessionCost,
		model: model?.id ? `${model.provider ?? "model"}/${model.id}` : "unknown model",
		tools,
		activeToolCount: active.size,
	};
}

function renderReport(snapshot: Snapshot, color: (name: string, text: string) => string, bold: (text: string) => string): string {
	const percentText = snapshot.percent == null ? "unknown" : `${snapshot.percent.toFixed(1)}%`;
	const title = color("accent", bold("Context Usage"));
	const muted = (s: string) => color("dim", s);
	const label = (s: string) => color("muted", s);
	const lines: string[] = [];

	lines.push(`${title}`);
	lines.push(...makeBlockGrid(snapshot.segments, snapshot.contextWindow, color));
	lines.push(
		`  ${snapshot.model} · ${formatTokens(snapshot.used)} / ${formatTokens(snapshot.contextWindow)} tokens (${color(pctColor(snapshot.percent), percentText)})`,
	);
	lines.push("");

	for (const segment of snapshot.segments) {
		lines.push(
			`  ${color(segment.color, segment.glyph)} ${label(segment.label.padEnd(13))} ${formatTokens(segment.tokens).padStart(8)} tokens (${pct(segment.tokens, snapshot.contextWindow)})`,
		);
	}

	lines.push("");
	lines.push(`${color("accent", bold("Breakdown"))}`);
	lines.push(`  ${label("Last turn")} ${formatTokens(snapshot.lastInput)} in + ${formatTokens(snapshot.lastOutput)} out`);
	lines.push(`  ${label("Session")}   ${formatTokens(snapshot.sessionInput)} in + ${formatTokens(snapshot.sessionOutput)} out · ${formatMoney(snapshot.sessionCost)}`);
	lines.push(`  ${label("Messages")}  ${snapshot.messageCount} total · ${snapshot.userMessages} user · ${snapshot.assistantMessages} assistant · ${snapshot.toolResults} tool results`);

	if (snapshot.tools.length) {
		lines.push("");
		lines.push(`${color("accent", bold(`Active tools (${snapshot.activeToolCount})`))}`);
		for (const tool of snapshot.tools.slice(0, 12)) {
			lines.push(`  └ ${tool.name} ${muted(`(${tool.source})`)}: ${formatTokens(tool.tokens)} tokens`);
		}
		if (snapshot.tools.length > 12) lines.push(`  ${muted(`… ${snapshot.tools.length - 12} more`)}`);
	}

	lines.push("");
	lines.push(muted("Token categories are estimated, then scaled to Pi's measured context total."));
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// Clear stale footer content left by older versions of this extension.
		ctx.ui.setStatus("context", undefined);
	});

	pi.registerCommand("context", {
		description: "Show a Claude-style context usage breakdown",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("context", undefined);
			const snapshot = buildSnapshot(pi, ctx);
			const theme = ctx.ui.theme;
			ctx.ui.notify(renderReport(snapshot, theme.fg.bind(theme), theme.bold.bind(theme)), "info");
		},
	});
}
