import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import path from "node:path";

export default function (pi: ExtensionAPI) {
	// Directory from which pi was started. All file access must stay inside it.
	const root = path.resolve(process.cwd());

	function insideRoot(p: string): boolean {
		const resolved = path.resolve(root, p);
		return resolved === root || resolved.startsWith(root + path.sep);
	}

	function blockPath(p: string) {
		return {
			block: true,
			reason: `Blocked: path is outside pi start directory.\nRoot: ${root}\nPath: ${p}`,
		};
	}

	pi.on("tool_call", async (event) => {
		// Block file tools from touching paths outside the startup directory.
		if (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") {
			const input = event.input as Record<string, unknown>;
			const filePath = input.path;

			if (typeof filePath === "string" && !insideRoot(filePath)) {
				return blockPath(filePath);
			}
		}

		// Bash is not perfectly sandboxable by regex, but this blocks common escapes.
		if (event.toolName === "bash") {
			const input = event.input as Record<string, unknown>;
			const command = String(input.command ?? "");

			const forbiddenPatterns = [
				/\bcd\b/,
				/\bpushd\b/,
				/\bpopd\b/,
				/\.\.\//,
				/\.\.\\/,
				/~\//,
				/\/etc\b/,
				/\/home\b/,
				/\/root\b/,
				/\/tmp\b/,
				/\/var\b/,
			];

			if (forbiddenPatterns.some((p) => p.test(command))) {
				return {
					block: true,
					reason: `Blocked bash command that may leave pi start directory.\nRoot: ${root}\nCommand: ${command}`,
				};
			}
		}

		return undefined;
	});
}
