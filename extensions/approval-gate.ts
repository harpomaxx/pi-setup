import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ApprovalMode = "mutating" | "all" | "readonly" | "yolo";

type Decision = "allow-once" | "allow-exact" | "allow-tool" | "deny";

function stableStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	return JSON.stringify(
		value,
		(_key, val) => {
			if (!val || typeof val !== "object") return val;
			if (seen.has(val)) return "[Circular]";
			seen.add(val);
			if (Array.isArray(val)) return val;
			return Object.keys(val as Record<string, unknown>)
				.sort()
				.reduce<Record<string, unknown>>((out, key) => {
					out[key] = (val as Record<string, unknown>)[key];
					return out;
				}, {});
		},
		2,
	);
}

function describeToolCall(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash" && typeof input.command === "string") {
		return "bash command";
	}
	if ((toolName === "write" || toolName === "edit" || toolName === "read") && typeof input.path === "string") {
		return `${toolName}: ${input.path}`;
	}
	return toolName;
}

type EditReplacement = {
	oldText: string;
	newText: string;
};

function isEditReplacement(value: unknown): value is EditReplacement {
	return !!value &&
		typeof value === "object" &&
		typeof (value as Record<string, unknown>).oldText === "string" &&
		typeof (value as Record<string, unknown>).newText === "string";
}

function truncate(text: string, maxLength = 16_000): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}\n... truncated ${text.length - maxLength} chars ...`;
}

function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split(/\r?\n/);
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function lineDiff(oldText: string, newText: string): string[] {
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	const dp = Array.from({ length: oldLines.length + 1 }, () => Array<number>(newLines.length + 1).fill(0));

	for (let i = oldLines.length - 1; i >= 0; i--) {
		for (let j = newLines.length - 1; j >= 0; j--) {
			dp[i][j] = oldLines[i] === newLines[j]
				? dp[i + 1][j + 1] + 1
				: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const out: string[] = [];
	let i = 0;
	let j = 0;
	while (i < oldLines.length && j < newLines.length) {
		if (oldLines[i] === newLines[j]) {
			out.push(` ${oldLines[i]}`);
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push(`-${oldLines[i]}`);
			i++;
		} else {
			out.push(`+${newLines[j]}`);
			j++;
		}
	}
	while (i < oldLines.length) out.push(`-${oldLines[i++]}`);
	while (j < newLines.length) out.push(`+${newLines[j++]}`);

	if (oldText.endsWith("\n") !== newText.endsWith("\n")) {
		out.push(newText.endsWith("\n") ? "+" : "-", "\\ No newline at end of old/new text differs");
	}

	return out;
}

function formatEditDetails(input: Record<string, unknown>): string | undefined {
	const path = typeof input.path === "string" ? input.path : "unknown path";
	const edits = Array.isArray(input.edits) ? input.edits : undefined;
	if (!edits || !edits.every(isEditReplacement)) return undefined;

	const lines = [
		"Diff preview:",
		"````diff",
		`--- ${path}`,
		`+++ ${path}`,
	];

	edits.forEach((edit, index) => {
		lines.push(`@@ edit ${index + 1}/${edits.length} @@`);
		lines.push(...lineDiff(edit.oldText, edit.newText));
		if (index < edits.length - 1) lines.push("");
	});

	lines.push("````");
	return truncate(lines.join("\n"));
}

function formatToolCallDetails(toolName: string, input: Record<string, unknown>): string {
	if (toolName === "bash" && typeof input.command === "string") {
		const lines = ["Command:", "```bash", input.command, "```"];
		const rest = { ...input };
		delete rest.command;
		if (Object.keys(rest).length > 0) {
			lines.push("", "Options:", stableStringify(rest));
		}
		return lines.join("\n");
	}

	if (toolName === "edit") {
		const details = formatEditDetails(input);
		if (details) return details;
	}

	return stableStringify(input);
}

/**
 * Approval Gate Extension
 *
 * Claude Code-like approvals for Pi.
 *
 * Commands:
 *   /approval              Show current mode and allowlist state
 *   /approval mutating     Ask before bash/write/edit (default)
 *   /approval all          Ask before every tool
 *   /approval readonly     Block bash/write/edit without asking
 *   /approval yolo         Allow every tool without asking
 *   /approval reset        Clear remembered approvals for this Pi process
 */
export default function (pi: ExtensionAPI) {
	let mode: ApprovalMode = "mutating";
	const mutatingTools = new Set(["bash", "write", "edit"]);
	const allowedExact = new Set<string>();
	const allowedTools = new Set<string>();

	const shouldGate = (toolName: string): boolean => {
		if (mode === "yolo") return false;
		if (mode === "readonly") return mutatingTools.has(toolName);
		if (mode === "all") return true;
		return mutatingTools.has(toolName);
	};

	const statusLines = () => [
		`Approval mode: ${mode}`,
		`Remembered exact approvals: ${allowedExact.size}`,
		`Remembered tool approvals: ${allowedTools.size ? [...allowedTools].sort().join(", ") : "none"}`,
		"",
		"Modes:",
		"  mutating  ask before bash/write/edit (default)",
		"  all       ask before every tool",
		"  readonly  block bash/write/edit",
		"  yolo      allow everything",
	];

	pi.registerCommand("approval", {
		description: "Configure Claude Code-like tool approvals: status, mutating, all, readonly, yolo, reset",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (!arg || arg === "status") {
				ctx.ui.notify(statusLines().join("\n"), "info");
				return;
			}

			if (arg === "reset") {
				allowedExact.clear();
				allowedTools.clear();
				ctx.ui.notify("Approval allowlist cleared", "info");
				return;
			}

			if (["mutating", "all", "readonly", "yolo"].includes(arg)) {
				mode = arg as ApprovalMode;
				ctx.ui.notify(`Approval mode set to ${mode}`, mode === "yolo" ? "warning" : "info");
				return;
			}

			ctx.ui.notify("Usage: /approval [status|mutating|all|readonly|yolo|reset]", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("approval-gate", `Approvals: ${mode}`);
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		const exactKey = `${event.toolName}:${stableStringify(input)}`;

		if (mode === "readonly" && mutatingTools.has(event.toolName)) {
			return { block: true, reason: `Approval mode is readonly; ${event.toolName} is blocked.` };
		}

		if (!shouldGate(event.toolName)) return undefined;
		if (allowedTools.has(event.toolName) || allowedExact.has(exactKey)) return undefined;

		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Tool "${event.toolName}" requires approval, but no UI is available.`,
			};
		}

		const summary = describeToolCall(event.toolName, input);
		const details = formatToolCallDetails(event.toolName, input);
		const choice = await ctx.ui.select(
			`Approve tool call?\n\n${summary}\n\n${details}`,
			[
				"Allow once",
				"Always allow this exact call this session",
				`Always allow ${event.toolName} this session`,
				"Deny",
			],
		) as string | undefined;

		const decision: Decision =
			choice === "Allow once" ? "allow-once" :
			choice === "Always allow this exact call this session" ? "allow-exact" :
			choice === `Always allow ${event.toolName} this session` ? "allow-tool" :
			"deny";

		if (decision === "allow-once") return undefined;
		if (decision === "allow-exact") {
			allowedExact.add(exactKey);
			return undefined;
		}
		if (decision === "allow-tool") {
			allowedTools.add(event.toolName);
			ctx.ui.setStatus("approval-gate", `Approvals: ${mode}, allowed ${[...allowedTools].sort().join(",")}`);
			return undefined;
		}

		return { block: true, reason: `User denied ${event.toolName}` };
	});
}
