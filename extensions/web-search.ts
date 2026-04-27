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

async function searchDuckDuckGo(
	query: string,
	maxResults: number,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

	const response = await fetch(searchUrl, {
		method: "GET",
		headers: {
			Accept: "text/html",
			"User-Agent":
				"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		},
		signal,
	});

	if (!response.ok) {
		throw new Error(`Search failed (${response.status}): ${response.statusText}`);
	}

	const html = await response.text();
	const results: SearchResult[] = [];

	// Parse html.duckduckgo.com result blocks
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

			let output = `Search results for "${params.query}":\n\n`;
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				output += `[${i + 1}] ${r.title}\n`;
				output += `URL: ${r.url}\n`;
				if (r.snippet) {
					output += `${r.snippet}\n`;
				}
				output += "\n";
			}

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
