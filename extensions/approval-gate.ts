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
		return `bash: ${input.command}`;
	}
	if ((toolName === "write" || toolName === "edit" || toolName === "read") && typeof input.path === "string") {
		return `${toolName}: ${input.path}`;
	}
	return `${toolName}: ${stableStringify(input)}`;
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
		const details = stableStringify(input);
		const choice = await ctx.ui.select(
			`Approve tool call?\n\n${summary}\n\nArguments:\n${details}`,
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
