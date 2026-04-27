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
}

// Realistic browser User-Agent strings to rotate through
const USER_AGENTS: string[] = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
];

// Endpoints to try in order
const ENDPOINTS: string[] = [
	"https://duckduckgo.com/html/",
	"https://html.duckduckgo.com/html/",
	"https://lite.duckduckgo.com/lite/",
];

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

		const rawUrl = titleMatch[1];
		const title = stripHtml(titleMatch[2]);

		const snippetMatch = block.match(
			/<a[^>]+class=["']result__snippet["'][^>]*>(.*?)<\/a>/is,
		);
		const snippet = snippetMatch ? stripHtml(snippetMatch[1]) : "";

		let url = rawUrl;
		if (url.startsWith("//")) url = "https:" + url;
		if (!url.startsWith("http")) continue;
		url = extractRealUrl(url);

		if (url.includes("duckduckgo.com") || !title) continue;

		results.push({ title, url, snippet });
	}
	return results;
}

function parseLiteHtml(html: string, maxResults: number): SearchResult[] {
	const results: SearchResult[] = [];
	// lite.duckduckgo.com uses table rows: link row, snippet row, URL row
	const rows = html.split(/<tr[^>]*>/i);

	let pendingTitle: string | null = null;
	let pendingUrl: string | null = null;

	for (let i = 1; i < rows.length && results.length < maxResults; i++) {
		const row = rows[i];
		// Title/link row
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

		// Snippet row
		const snippetMatch = row.match(
			/<td[^>]+class=["']result-snippet["'][^>]*>(.*?)<\/td>/is,
		);
		if (snippetMatch && pendingTitle && pendingUrl) {
			const snippet = stripHtml(snippetMatch[1]);
			if (pendingUrl.startsWith("http") && !pendingUrl.includes("duckduckgo.com")) {
				results.push({ title: pendingTitle, url: pendingUrl, snippet });
			}
			pendingTitle = null;
			pendingUrl = null;
			continue;
		}

		// Some lite pages don't have a separate snippet row; just commit if we have a title
		const urlRowMatch = row.match(
			/<td[^>]+class=["']result-url["'][^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/is,
		);
		if (urlRowMatch && pendingTitle && pendingUrl) {
			if (pendingUrl.startsWith("http") && !pendingUrl.includes("duckduckgo.com")) {
				results.push({ title: pendingTitle, url: pendingUrl, snippet: "" });
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
			if (signal?.aborted) {
				throw new Error("Search aborted.");
			}

			const userAgent = USER_AGENTS[(endpointIdx + attempt) % USER_AGENTS.length];

			// Build query string; lite endpoint uses 'q=', html uses 'q='
			const searchUrl = `${endpoint}?q=${encodeURIComponent(query)}`;

			try {
				const response = await fetch(searchUrl, {
					method: "GET",
					headers: {
						Accept: "text/html",
						"User-Agent": userAgent,
						...(isLite
							? { Referer: "https://duckduckgo.com/" }
							: {}),
					},
					signal,
				});

				if (!response.ok) {
					// Non-2xx: treat as retryable for some codes
					if (response.status === 429 || response.status >= 500) {
						throw new Error(`HTTP ${response.status}`);
					}
					throw new Error(
						`Search failed (${response.status}): ${response.statusText}`,
					);
				}

				const html = await response.text();

				if (isCaptchaResponse(html)) {
					throw new Error("CAPTCHA detected");
				}

				const results = isLite
					? parseLiteHtml(html, maxResults)
					: parseStandardHtml(html, maxResults);

				if (results.length > 0) {
					return results;
				}

				// Zero results from a parse: might be a layout change.
				// Treat as retryable one more time, then move endpoint.
				if (attempt < MAX_RETRIES - 1) {
					throw new Error("Zero parsed results");
				}
			} catch (err) {
				lastError =
					err instanceof Error ? err : new Error(String(err));

				const isRetryable =
					lastError.message.includes("CAPTCHA") ||
					lastError.message.includes("429") ||
					lastError.message.includes("HTTP 5") ||
					lastError.message.includes("Zero parsed results");

				if (!isRetryable) {
					throw lastError;
				}

				// Exponential backoff with jitter
				const backoff = BASE_DELAY_MS * Math.pow(2, attempt);
				const jitter = Math.random() * 500;
				await delay(backoff + jitter);
			}
		}
	}

	// All endpoints + retries exhausted
	throw new Error(
		lastError?.message.includes("CAPTCHA")
			? "DuckDuckGo blocked this request with a CAPTCHA (bot detection) after " +
			  `${MAX_RETRIES} retries on ${ENDPOINTS.length} endpoints. ` +
			  "This usually happens on cloud/VPN IPs. Try running Pi from a different network, " +
			  "or consider adding a search API key (Brave, Serper.dev, etc.)."
			: (lastError?.message ?? "No results found after trying all endpoints."),
	);
}

function formatResults(query: string, results: SearchResult[]): string {
	let output = `Search results for "${query}":\n\n`;
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		output += `[${i + 1}] ${r.title}\n`;
		output += `URL: ${r.url}\n`;
		if (r.snippet) {
			output += `${r.snippet}\n`;
		}
		output += "\n";
	}
	return output;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `Search the web using DuckDuckGo. Returns search results with titles, URLs, and snippets. Use this when you need up-to-date information not available in your training data, to verify facts, research topics, find documentation, or investigate errors. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Search the web for current information, facts, or documentation",
		promptGuidelines: [
			"Use web_search when the user asks about recent events, current versions, or information that may have changed after your knowledge cutoff.",
			"Use web_search to verify technical facts or find official documentation URLs.",
			"Use web_search to find solutions to errors or bugs reported by the user.",
			"Use web_search to research libraries, APIs, or tools the user mentions.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			max_results: Type.Optional(
				Type.Number({ description: "Maximum results to return (default: 5, max: 10)" }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const maxResults = Math.min(Math.max(1, params.max_results ?? 5), 10);

			const results = await searchDuckDuckGo(params.query, maxResults, signal);

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: "No results found for the query." }],
					details: { query: params.query, count: 0 },
				};
			}

			const output = formatResults(params.query, results);

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
				if (ctx.hasUI) {
					ctx.ui.notify("Usage: /websearch <query>", "warning");
				}
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify(`Searching: ${query}...`, "info");
			}

			try {
				const results = await searchDuckDuckGo(query, 5);
				if (results.length === 0) {
					if (ctx.hasUI) {
						ctx.ui.notify("No results found.", "warning");
					}
					return;
				}

				const lines = [`Results for "${query}":`, ""];
				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					lines.push(`${i + 1}. ${r.title}`);
					lines.push(`   ${r.url}`);
					if (r.snippet) lines.push(`   ${r.snippet}`);
					lines.push("");
				}

				if (ctx.hasUI) {
					ctx.ui.notify(lines.join("\n"), "info");
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (ctx.hasUI) {
					ctx.ui.notify(`Search failed: ${message}`, "error");
				}
			}
		},
	});
}
