import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	age?: string;
	source: "brave" | "duckduckgo";
}

// Realistic browser User-Agent strings to rotate through for DuckDuckGo fallback.
const USER_AGENTS: string[] = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
];

const ENDPOINTS: string[] = [
	"https://duckduckgo.com/html/",
	"https://html.duckduckgo.com/html/",
	"https://lite.duckduckgo.com/lite/",
];

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1500;

function stripHtml(html: string): string {
	return html
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
		.trim();
}

function extractRealUrl(redirectUrl: string): string {
	try {
		if (redirectUrl.includes("uddg=")) {
			const url = new URL(redirectUrl, "https://duckduckgo.com");
			const real = url.searchParams.get("uddg");
			if (real) return decodeURIComponent(real);
		}
	} catch {
		// ignore parse errors
	}
	return redirectUrl;
}

function isCaptchaResponse(html: string): boolean {
	const markers = [
		"anomaly-modal",
		"Unfortunately, bots use",
		"Please confirm you are human",
		"captcha",
		"If this error persists",
		"Blocked!",
	];
	const lower = html.toLowerCase();
	return markers.some((m) => lower.includes(m.toLowerCase()));
}

function parseStandardHtml(html: string, maxResults: number): SearchResult[] {
	const results: SearchResult[] = [];
	const resultDivs = html.split(/<div[^>]*class=["'][^"']*result[^"']*["'][^>]*>/gi);

	for (let i = 1; i < resultDivs.length && results.length < maxResults; i++) {
		const block = resultDivs[i];
		const titleMatch = block.match(
			/<a[^>]+class=["']result__a["'][^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/is,
		);
		if (!titleMatch) continue;

		let url = titleMatch[1];
		if (url.startsWith("//")) url = "https:" + url;
		if (!url.startsWith("http")) continue;
		url = extractRealUrl(url);

		const title = stripHtml(titleMatch[2]);
		const snippetMatch = block.match(
			/<a[^>]+class=["']result__snippet["'][^>]*>(.*?)<\/a>/is,
		);
		const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";

		if (url.includes("duckduckgo.com") || !title) continue;
		results.push({ title, url, snippet, source: "duckduckgo" });
	}
	return results;
}

function parseLiteHtml(html: string, maxResults: number): SearchResult[] {
	const results: SearchResult[] = [];
	const rows = html.split(/<tr[^>]*>/i);
	let pendingTitle: string | null = null;
	let pendingUrl: string | null = null;

	for (let i = 1; i < rows.length && results.length < maxResults; i++) {
		const row = rows[i];
		const linkMatch = row.match(
			/<a[^>]+class=["']result-link["'][^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/is,
		);
		if (linkMatch) {
			pendingUrl = linkMatch[1];
			pendingTitle = stripHtml(linkMatch[2]);
			if (pendingUrl.startsWith("//")) pendingUrl = "https:" + pendingUrl;
			pendingUrl = extractRealUrl(pendingUrl);
			continue;
		}

		const snippetMatch = row.match(
			/<td[^>]+class=["']result-snippet["'][^>]*>(.*?)<\/td>/is,
		);
		if (snippetMatch && pendingTitle && pendingUrl) {
			const snippet = stripHtml(snippetMatch[1]);
			if (pendingUrl.startsWith("http") && !pendingUrl.includes("duckduckgo.com")) {
				results.push({ title: pendingTitle, url: pendingUrl, snippet, source: "duckduckgo" });
			}
			pendingTitle = null;
			pendingUrl = null;
			continue;
		}

		const urlRowMatch = row.match(
			/<td[^>]+class=["']result-url["'][^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/is,
		);
		if (urlRowMatch && pendingTitle && pendingUrl) {
			if (pendingUrl.startsWith("http") && !pendingUrl.includes("duckduckgo.com")) {
				results.push({ title: pendingTitle, url: pendingUrl, snippet: "", source: "duckduckgo" });
			}
			pendingTitle = null;
			pendingUrl = null;
		}
	}
	return results;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchBrave(
	query: string,
	maxResults: number,
	options: { country?: string; freshness?: string },
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const apiKey = process.env.BRAVE_API_KEY;
	if (!apiKey) {
		throw new Error("BRAVE_API_KEY is not set.");
	}

	const url = new URL(BRAVE_SEARCH_ENDPOINT);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(Math.min(Math.max(1, maxResults), 20)));
	url.searchParams.set("text_decorations", "false");
	url.searchParams.set("search_lang", "en");
	url.searchParams.set("country", options.country ?? "US");
	if (options.freshness) url.searchParams.set("freshness", options.freshness);

	const response = await fetch(url, {
		method: "GET",
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": apiKey,
		},
		signal,
	});

	if (!response.ok) {
		let body = "";
		try {
			body = await response.text();
		} catch {
			// ignore body read errors
		}
		throw new Error(
			`Brave Search failed (${response.status}): ${response.statusText}${body ? ` - ${body.slice(0, 500)}` : ""}`,
		);
	}

	const data = await response.json() as {
		web?: {
			results?: Array<{
				title?: string;
				url?: string;
				description?: string;
				age?: string;
			}>;
		};
	};

	return (data.web?.results ?? [])
		.filter((r) => r.title && r.url)
		.slice(0, maxResults)
		.map((r) => ({
			title: stripHtml(r.title ?? ""),
			url: r.url ?? "",
			snippet: stripHtml(r.description ?? ""),
			age: r.age,
			source: "brave" as const,
		}));
}

async function searchDuckDuckGo(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	let lastError: Error | undefined;

	for (let endpointIdx = 0; endpointIdx < ENDPOINTS.length; endpointIdx++) {
		const endpoint = ENDPOINTS[endpointIdx];
		const isLite = endpoint.includes("lite.duckduckgo");

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			if (signal?.aborted) throw new Error("Search aborted.");

			const userAgent = USER_AGENTS[(endpointIdx + attempt) % USER_AGENTS.length];
			const searchUrl = `${endpoint}?q=${encodeURIComponent(query)}`;

			try {
				const response = await fetch(searchUrl, {
					method: "GET",
					headers: {
						Accept: "text/html",
						"User-Agent": userAgent,
						...(isLite ? { Referer: "https://duckduckgo.com/" } : {}),
					},
					signal,
				});

				if (!response.ok) {
					if (response.status === 429 || response.status >= 500) {
						throw new Error(`HTTP ${response.status}`);
					}
					throw new Error(`Search failed (${response.status}): ${response.statusText}`);
				}

				const html = await response.text();
				if (isCaptchaResponse(html)) throw new Error("CAPTCHA detected");

				const results = isLite
					? parseLiteHtml(html, maxResults)
					: parseStandardHtml(html, maxResults);
				if (results.length > 0) return results;
				if (attempt < MAX_RETRIES - 1) throw new Error("Zero parsed results");
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				const isRetryable =
					lastError.message.includes("CAPTCHA") ||
					lastError.message.includes("429") ||
					lastError.message.includes("HTTP 5") ||
					lastError.message.includes("Zero parsed results");

				if (!isRetryable) throw lastError;
				await delay(BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500);
			}
		}
	}

	throw new Error(
		lastError?.message.includes("CAPTCHA")
			? `DuckDuckGo blocked this request with a CAPTCHA after ${MAX_RETRIES} retries on ${ENDPOINTS.length} endpoints.`
			: (lastError?.message ?? "No results found after trying all endpoints."),
	);
}

async function searchWeb(
	query: string,
	maxResults: number,
	options: { country?: string; freshness?: string; provider?: "brave" | "duckduckgo" | "auto" },
	signal?: AbortSignal,
): Promise<{ results: SearchResult[]; provider: "brave" | "duckduckgo"; fallbackReason?: string }> {
	const provider = options.provider ?? "auto";

	if (provider === "brave" || (provider === "auto" && process.env.BRAVE_API_KEY)) {
		try {
			return {
				results: await searchBrave(query, maxResults, options, signal),
				provider: "brave",
			};
		} catch (err) {
			if (provider === "brave") throw err;
			const fallbackReason = err instanceof Error ? err.message : String(err);
			return {
				results: await searchDuckDuckGo(query, Math.min(maxResults, 10), signal),
				provider: "duckduckgo",
				fallbackReason,
			};
		}
	}

	return {
		results: await searchDuckDuckGo(query, Math.min(maxResults, 10), signal),
		provider: "duckduckgo",
	};
}

function formatResults(query: string, results: SearchResult[], provider: string, fallbackReason?: string): string {
	let output = `Search results for "${query}" (${provider}):\n\n`;
	if (fallbackReason) {
		output += `Note: Brave Search failed, fell back to DuckDuckGo. Reason: ${fallbackReason}\n\n`;
	}
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		output += `[${i + 1}] ${r.title}\n`;
		output += `URL: ${r.url}\n`;
		if (r.age) output += `Age: ${r.age}\n`;
		if (r.snippet) output += `${r.snippet}\n`;
		output += "\n";
	}
	return output;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `Search the web using Brave Search API when BRAVE_API_KEY is set, with DuckDuckGo fallback in auto mode. Returns titles, URLs, and snippets. Use this for current information, documentation, fact verification, research, or debugging. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Search the web with Brave Search API, falling back to DuckDuckGo if configured for auto mode",
		promptGuidelines: [
			"Use web_search when the user asks about recent events, current versions, or information that may have changed after your knowledge cutoff.",
			"Use web_search to verify technical facts or find official documentation URLs.",
			"Use web_search to find solutions to errors or bugs reported by the user.",
			"Use web_search to research libraries, APIs, or tools the user mentions.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			max_results: Type.Optional(
				Type.Number({ description: "Maximum results to return (default: 5, max: 20 for Brave; max: 10 for DuckDuckGo)" }),
			),
			provider: Type.Optional(
				Type.Union([
					Type.Literal("auto"),
					Type.Literal("brave"),
					Type.Literal("duckduckgo"),
				], { description: "Search provider. Default: auto (Brave if BRAVE_API_KEY is set, otherwise DuckDuckGo)." }),
			),
			country: Type.Optional(Type.String({ description: "Two-letter country code for Brave Search (default: US)" })),
			freshness: Type.Optional(Type.String({ description: "Brave freshness filter: pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD" })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const maxResults = Math.min(Math.max(1, params.max_results ?? 5), 20);
			const { results, provider, fallbackReason } = await searchWeb(
				params.query,
				maxResults,
				{
					provider: params.provider,
					country: params.country,
					freshness: params.freshness,
				},
				signal,
			);

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: "No results found for the query." }],
					details: { query: params.query, provider, count: 0 },
				};
			}

			const output = formatResults(params.query, results, provider, fallbackReason);
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let resultText = truncation.content;
			if (truncation.truncated) {
				resultText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					query: params.query,
					provider,
					fallbackReason,
					count: results.length,
					truncated: truncation.truncated,
				},
			};
		},
	});

	pi.registerCommand("websearch", {
		description: "Manually search the web and show results in the UI",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /websearch <query>", "warning");
				return;
			}

			if (ctx.hasUI) ctx.ui.notify(`Searching: ${query}...`, "info");

			try {
				const { results, provider, fallbackReason } = await searchWeb(query, 5, { provider: "auto" });
				if (results.length === 0) {
					if (ctx.hasUI) ctx.ui.notify("No results found.", "warning");
					return;
				}

				const lines = [`Results for "${query}" (${provider}):`, ""];
				if (fallbackReason) {
					lines.push(`Brave fallback reason: ${fallbackReason}`, "");
				}
				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					lines.push(`${i + 1}. ${r.title}`);
					lines.push(`   ${r.url}`);
					if (r.snippet) lines.push(`   ${r.snippet}`);
					lines.push("");
				}

				if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (ctx.hasUI) ctx.ui.notify(`Search failed: ${message}`, "error");
			}
		},
	});
}
