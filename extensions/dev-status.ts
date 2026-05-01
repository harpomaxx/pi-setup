import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);
const STATUS_KEY = "dev-status";
const REFRESH_MS = 5000;

function formatCwd(cwd: string): string {
	const home = os.homedir();
	let display = cwd === home ? "~" : cwd.startsWith(home + path.sep) ? "~" + cwd.slice(home.length) : cwd;

	// Keep the footer readable in deeply nested projects.
	const parts = display.split(path.sep).filter(Boolean);
	if (display.startsWith("~/") && parts.length > 4) {
		display = path.join("~", "…", ...parts.slice(-3));
	} else if (!display.startsWith("~") && parts.length > 4) {
		display = path.join(path.sep, "…", ...parts.slice(-3));
	}
	return display;
}

async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
			timeout: 1500,
			maxBuffer: 128 * 1024,
		});
		return stdout.trim();
	} catch {
		return undefined;
	}
}

async function getGitInfo(cwd: string): Promise<{ branch: string; dirty: boolean } | undefined> {
	const inside = await gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") return undefined;

	const branch =
		(await gitOutput(cwd, ["branch", "--show-current"])) ||
		(await gitOutput(cwd, ["rev-parse", "--short", "HEAD"])) ||
		"unknown";
	const status = await gitOutput(cwd, ["status", "--porcelain"]);
	return { branch, dirty: Boolean(status) };
}

async function updateStatus(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	const cwd = formatCwd(ctx.cwd);
	const git = await getGitInfo(ctx.cwd);
	const theme = ctx.ui.theme;
	const cwdText = theme.fg("dim", `📁 ${cwd}`);
	const gitText = git
		? theme.fg("accent", ` ${git.branch}${git.dirty ? "*" : ""}`)
		: theme.fg("dim", "no git");

	ctx.ui.setStatus(STATUS_KEY, `${cwdText} ${gitText}`);
}

export default function (pi: ExtensionAPI) {
	let refreshTimer: NodeJS.Timeout | undefined;

	function stopRefresh() {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
	}

	function startRefresh(ctx: ExtensionContext) {
		stopRefresh();
		void updateStatus(ctx);
		refreshTimer = setInterval(() => void updateStatus(ctx), REFRESH_MS);
		refreshTimer.unref?.();
	}

	pi.on("session_start", async (_event, ctx) => {
		startRefresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopRefresh();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("user_bash", async (_event, ctx) => {
		// Refresh after shell commands such as `git checkout` or `git switch`.
		setTimeout(() => void updateStatus(ctx), 250).unref?.();
	});

	pi.registerCommand("devstatus", {
		description: "Refresh the cwd/git status footer entry",
		handler: async (_args, ctx) => {
			await updateStatus(ctx);
			ctx.ui.notify("Dev status refreshed", "info");
		},
	});
}
