import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Library = { kind: "user" | "group"; id: string; label: string };
type Creator = { firstName?: string; lastName?: string; name?: string; creatorType?: string };
type ZoteroItemInput = {
	itemType?: string; title?: string; creators?: Creator[]; date?: string; doi?: string; url?: string;
	publicationTitle?: string; abstractNote?: string; tags?: string[]; collections?: string[];
	libraryKind?: "user" | "group"; libraryId?: string;
};
type ZoteroRequestInit = RequestInit & { timeoutMs?: number };

function apiKey(): string {
	const key = process.env.ZOTERO_API_KEY;
	if (!key) throw new Error("ZOTERO_API_KEY is not set. Export it before starting Pi.");
	return key;
}

function truncate(text: string, maxChars = 18000): string {
	return text.length > maxChars ? text.slice(0, maxChars) + "\n... [truncated]" : text;
}

function libraryPath(lib: Library): string {
	return lib.kind === "user" ? `/users/${encodeURIComponent(lib.id)}` : `/groups/${encodeURIComponent(lib.id)}`;
}

function withTimeout(signal: AbortSignal | undefined, ms = 12000): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

class ZoteroHTTPError extends Error {
	constructor(message: string, public status: number, public headers: Record<string, string>) {
		super(message);
	}
}

let activeZoteroRequests = 0;
const pendingZoteroRequests: Array<() => void> = [];
let nextZoteroRequestAt = 0;

function zoteroMinIntervalMs(): number {
	const n = Number(process.env.ZOTERO_MIN_INTERVAL_MS || 350);
	return Number.isFinite(n) && n >= 0 ? n : 350;
}

function zoteroConcurrency(): number {
	const n = Number(process.env.ZOTERO_CONCURRENCY || 4);
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}

function zoteroRequestTimeoutMs(): number {
	const n = Number(process.env.ZOTERO_REQUEST_TIMEOUT_MS || 12000);
	return Number.isFinite(n) && n > 0 ? n : 12000;
}

function zoteroSearchRequestTimeoutMs(): number {
	const n = Number(process.env.ZOTERO_SEARCH_REQUEST_TIMEOUT_MS || 15000);
	return Number.isFinite(n) && n > 0 ? n : 15000;
}

function zoteroSearchBudgetMs(): number {
	const n = Number(process.env.ZOTERO_SEARCH_BUDGET_MS || 24000);
	return Number.isFinite(n) && n > 0 ? n : 24000;
}

function zoteroMaxRetries(): number {
	const n = Number(process.env.ZOTERO_MAX_RETRIES || 6);
	return Number.isFinite(n) && n >= 0 ? n : 6;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason || new Error("Operation aborted"));
		const timer = setTimeout(done, ms);
		function done() {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}
		function onAbort() {
			clearTimeout(timer);
			reject(signal?.reason || new Error("Operation aborted"));
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function headerDelayMs(headers: Record<string, string>, name: string): number | undefined {
	const value = headers[name.toLowerCase()] || headers[name];
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const dateMs = Date.parse(value);
	return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function exponentialDelayMs(attempt: number): number {
	const base = Number(process.env.ZOTERO_BACKOFF_BASE_MS || 500);
	const max = Number(process.env.ZOTERO_BACKOFF_MAX_MS || 60000);
	const jitter = Math.random() * Math.max(250, base);
	return Math.min(Number.isFinite(max) ? max : 60000, (Number.isFinite(base) ? base : 500) * 2 ** attempt + jitter);
}

async function waitForZoteroSlot(signal?: AbortSignal): Promise<void> {
	const waitMs = nextZoteroRequestAt - Date.now();
	if (waitMs > 0) await abortableSleep(waitMs, signal);
	nextZoteroRequestAt = Date.now() + zoteroMinIntervalMs();
}

function honorZoteroBackoff(headers: Record<string, string>): void {
	const delayMs = headerDelayMs(headers, "backoff");
	if (delayMs !== undefined) nextZoteroRequestAt = Math.max(nextZoteroRequestAt, Date.now() + delayMs);
}

async function acquireZoteroQueueSlot(signal?: AbortSignal): Promise<void> {
	if (activeZoteroRequests < zoteroConcurrency()) {
		activeZoteroRequests++;
		return;
	}
	await new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason || new Error("Operation aborted"));
		let queued = true;
		const start = () => {
			queued = false;
			signal?.removeEventListener("abort", onAbort);
			activeZoteroRequests++;
			resolve();
		};
		const onAbort = () => {
			if (!queued) return;
			queued = false;
			const index = pendingZoteroRequests.indexOf(start);
			if (index >= 0) pendingZoteroRequests.splice(index, 1);
			reject(signal?.reason || new Error("Operation aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		pendingZoteroRequests.push(start);
	});
}

function releaseZoteroQueueSlot(): void {
	activeZoteroRequests = Math.max(0, activeZoteroRequests - 1);
	while (activeZoteroRequests < zoteroConcurrency() && pendingZoteroRequests.length) {
		pendingZoteroRequests.shift()?.();
	}
}

async function enqueueZoteroRequest<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	await acquireZoteroQueueSlot(signal);
	try {
		return await task();
	} finally {
		releaseZoteroQueueSlot();
	}
}

async function performZoteroRequest(path: string, init: ZoteroRequestInit = {}, signal?: AbortSignal): Promise<{ data: any; headers: Record<string, string> }> {
	await waitForZoteroSlot(signal);
	const { timeoutMs, ...fetchInit } = init;
	const res = await fetch(`https://api.zotero.org${path}`, {
		...fetchInit,
		signal: withTimeout(signal, timeoutMs || zoteroRequestTimeoutMs()),
		headers: {
			"Zotero-API-Key": apiKey(),
			"Zotero-API-Version": "3",
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...(init.headers || {}),
		},
	});
	const text = await res.text();
	let data: any = null;
	try { data = text ? JSON.parse(text) : null; } catch { data = text; }
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => { headers[k] = v; });
	honorZoteroBackoff(headers);
	if (!res.ok) {
		if (res.status === 401 || res.status === 403) throw new ZoteroHTTPError(`Zotero authorization failed (${res.status}). Check ZOTERO_API_KEY permissions.`, res.status, headers);
		if (res.status === 404) throw new ZoteroHTTPError(`Zotero resource not found (404): ${path}`, res.status, headers);
		if (res.status === 429) throw new ZoteroHTTPError("Zotero API rate limited this request (429). Retrying with backoff.", res.status, headers);
		throw new ZoteroHTTPError(`Zotero API error (${res.status}): ${typeof data === "string" ? data : JSON.stringify(data).slice(0, 1000)}`, res.status, headers);
	}
	return { data, headers };
}

async function zoteroRequestWithBackoff(path: string, init: ZoteroRequestInit = {}, signal?: AbortSignal): Promise<{ data: any; headers: Record<string, string> }> {
	const maxRetries = zoteroMaxRetries();
	for (let attempt = 0; ; attempt++) {
		try {
			return await performZoteroRequest(path, init, signal);
		} catch (error) {
			const status = error instanceof ZoteroHTTPError ? error.status : 0;
			const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
			if (!retryable || attempt >= maxRetries) throw error;
			const headers = error instanceof ZoteroHTTPError ? error.headers : {};
			const delayMs = headerDelayMs(headers, "retry-after") ?? headerDelayMs(headers, "backoff") ?? exponentialDelayMs(attempt);
			nextZoteroRequestAt = Math.max(nextZoteroRequestAt, Date.now() + delayMs);
			await abortableSleep(delayMs, signal);
		}
	}
}

async function rawZoteroRequest(path: string, init: ZoteroRequestInit = {}, signal?: AbortSignal): Promise<{ data: any; headers: Record<string, string> }> {
	return enqueueZoteroRequest(() => zoteroRequestWithBackoff(path, init, signal), signal);
}

async function directZoteroRequest(path: string, init: ZoteroRequestInit = {}, signal?: AbortSignal): Promise<{ data: any; headers: Record<string, string> }> {
	const { timeoutMs, ...fetchInit } = init;
	const res = await fetch(`https://api.zotero.org${path}`, {
		...fetchInit,
		signal: withTimeout(signal, timeoutMs || zoteroSearchRequestTimeoutMs()),
		headers: {
			"Zotero-API-Key": apiKey(),
			"Zotero-API-Version": "3",
			"Accept": "application/json",
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...(init.headers || {}),
		},
	});
	const text = await res.text();
	let data: any = null;
	try { data = text ? JSON.parse(text) : null; } catch { data = text; }
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => { headers[k] = v; });
	if (!res.ok) throw new ZoteroHTTPError(`Zotero API error (${res.status}): ${typeof data === "string" ? data : JSON.stringify(data).slice(0, 500)}`, res.status, headers);
	return { data, headers };
}

async function getLibraries(signal?: AbortSignal): Promise<Library[]> {
	// Explicit env vars still work and restrict scope if set.
	if (process.env.ZOTERO_GROUP_ID) return [{ kind: "group", id: process.env.ZOTERO_GROUP_ID, label: `group/${process.env.ZOTERO_GROUP_ID}` }];
	if (process.env.ZOTERO_USER_ID || process.env.ZOTERO_LIBRARY_ID) {
		const id = process.env.ZOTERO_USER_ID || process.env.ZOTERO_LIBRARY_ID || "";
		return [{ kind: "user", id, label: `user/${id}` }];
	}

	// Otherwise query every library this key can access: personal user library + all groups.
	const { data } = await rawZoteroRequest("/keys/current", {}, signal);
	const libs: Library[] = [];
	const userID = data?.userID ?? data?.userId;
	if (userID && data?.access?.user?.library !== false) libs.push({ kind: "user", id: String(userID), label: `user/${userID}` });
	const groups = data?.access?.groups || {};
	if (groups.all && userID) {
		const groupList = await rawZoteroRequest(`/users/${encodeURIComponent(String(userID))}/groups?format=json`, {}, signal);
		if (Array.isArray(groupList.data)) {
			for (const group of groupList.data) {
				const id = group.id ?? group.groupID ?? group.data?.id ?? group.data?.groupID;
				const name = group.name ?? group.data?.name;
				if (id) libs.push({ kind: "group", id: String(id), label: `group/${id}${name ? ` (${name})` : ""}` });
			}
		}
	} else {
		for (const [groupID, access] of Object.entries(groups)) {
			if ((access as any)?.library !== false) libs.push({ kind: "group", id: String(groupID), label: `group/${groupID}` });
		}
	}
	if (!libs.length) throw new Error("This Zotero API key does not appear to have access to any user or group libraries.");
	return libs;
}

async function zoteroRequest(lib: Library, path: string, init: ZoteroRequestInit = {}, signal?: AbortSignal) {
	return rawZoteroRequest(`${libraryPath(lib)}${path}`, init, signal);
}

function libraryDisplayName(lib: Library): string {
	const match = lib.label.match(/\((.*)\)$/);
	return match?.[1] || lib.label;
}

async function resolveLibrarySpec(spec: unknown, signal?: AbortSignal): Promise<Library> {
	const value = String(spec || "").trim();
	const libs = await getLibraries(signal);
	if (!value || value.toLowerCase() === "personal" || value.toLowerCase() === "user") {
		const personal = libs.find((l) => l.kind === "user");
		if (personal) return personal;
		return libs[0];
	}
	if (/^group\/\d+$/.test(value)) {
		const id = value.split("/")[1];
		const lib = libs.find((l) => l.kind === "group" && l.id === id);
		if (lib) return lib;
	}
	if (/^user\/\d+$/.test(value)) {
		const id = value.split("/")[1];
		const lib = libs.find((l) => l.kind === "user" && l.id === id);
		if (lib) return lib;
	}
	if (/^\d+$/.test(value)) {
		const lib = libs.find((l) => l.kind === "group" && l.id === value) || libs.find((l) => l.id === value);
		if (lib) return lib;
	}
	const lower = value.toLowerCase();
	const exact = libs.filter((l) => libraryDisplayName(l).toLowerCase() === lower || l.label.toLowerCase() === lower);
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) throw new Error(`Multiple Zotero libraries matched ${value}: ${exact.map((l) => l.label).join("; ")}`);
	const fuzzy = libs.filter((l) => libraryDisplayName(l).toLowerCase().includes(lower) || l.label.toLowerCase().includes(lower));
	if (fuzzy.length === 1) return fuzzy[0];
	if (fuzzy.length > 1) throw new Error(`Multiple Zotero libraries matched ${value}. Use a group ID: ${fuzzy.slice(0, 8).map((l) => l.label).join("; ")}`);
	throw new Error(`No Zotero library matched ${value}. Use zotero_libraries to see available libraries.`);
}

async function resolveLibraryList(specs: unknown, signal?: AbortSignal): Promise<Library[]> {
	const text = String(specs || "").trim();
	if (!text || text.toLowerCase() === "all") return getLibraries(signal);
	const libs: Library[] = [];
	for (const token of text.split(",").map((s) => s.trim()).filter(Boolean)) libs.push(await resolveLibrarySpec(token, signal));
	return libs;
}

function creatorsToText(creators: any[] | undefined): string {
	return (creators || []).map((c) => c.name || [c.firstName, c.lastName].filter(Boolean).join(" ")).filter(Boolean).slice(0, 8).join("; ");
}

function sourceSummary(entry: any): Record<string, unknown> {
	const data = entry.data || entry;
	const date = String(data.date || "");
	return {
		item_key: data.key || entry.key,
		library: entry.libraryLabel || entry.library?.label || entry.library || "?",
		item_type: data.itemType || "?",
		title: data.title || data.shortTitle || data.name || "(untitled)",
		creators: (data.creators || []).map((c: any) => c.name || [c.firstName, c.lastName].filter(Boolean).join(" ")).filter(Boolean).slice(0, 8),
		date,
		year: date.slice(0, 4),
		publication_title: data.publicationTitle || data.bookTitle || data.proceedingsTitle || data.websiteTitle || "",
		doi: data.DOI || "",
		url: data.url || "",
		tags: (data.tags || []).map((t: any) => t.tag).filter(Boolean).slice(0, 12),
		abstract_note: truncate(String(data.abstractNote || ""), 500),
	};
}

function formatItem(entry: any): string {
	const data = entry.data || entry;
	const title = data.title || "(untitled)";
	const authors = creatorsToText(data.creators);
	const tags = (data.tags || []).map((t: any) => t.tag).filter(Boolean).slice(0, 8).join(", ");
	const bits = [`- ${title}`, `  Library: ${entry.libraryLabel || entry.library || "?"}`, `  Key: ${data.key || entry.key}`, `  Type: ${data.itemType || "?"}`];
	if (authors) bits.push(`  Creators: ${authors}`);
	if (data.date) bits.push(`  Date: ${data.date}`);
	if (data.publicationTitle || data.bookTitle || data.proceedingsTitle) bits.push(`  Publication: ${data.publicationTitle || data.bookTitle || data.proceedingsTitle}`);
	if (data.dateAdded) bits.push(`  Added: ${data.dateAdded}`);
	if (data.dateModified) bits.push(`  Modified: ${data.dateModified}`);
	if (data.DOI) bits.push(`  DOI: ${data.DOI}`);
	if (data.ISBN) bits.push(`  ISBN: ${data.ISBN}`);
	if (data.url) bits.push(`  URL: ${data.url}`);
	if (tags) bits.push(`  Tags: ${tags}`);
	if (entry.links?.alternate?.href) bits.push(`  Zotero: ${entry.links.alternate.href}`);
	return bits.join("\n");
}

function formatSourceSummary(entry: any): string {
	const s = sourceSummary(entry);
	const bits = [`- ${s.title}`, `  Library: ${s.library}`, `  Key: ${s.item_key}`, `  Type: ${s.item_type}`];
	if ((s.creators as string[]).length) bits.push(`  Creators: ${(s.creators as string[]).join("; ")}`);
	if (s.year) bits.push(`  Year: ${s.year}`);
	if (s.publication_title) bits.push(`  Publication: ${s.publication_title}`);
	if (s.doi) bits.push(`  DOI: ${s.doi}`);
	if (s.url) bits.push(`  URL: ${s.url}`);
	return bits.join("\n");
}

function buildQuery(params: Record<string, unknown>, perLibraryLimit: number): string {
	const qs = new URLSearchParams();
	qs.set("format", "json");
	qs.set("include", "data");
	qs.set("limit", String(perLibraryLimit));
	if (params.start !== undefined) qs.set("start", String(params.start));
	if (params.query) { qs.set("q", String(params.query)); qs.set("qmode", String(params.qmode || "titleCreatorYear")); }
	qs.set("itemType", String(params.itemType || "-attachment"));
	if (params.tag) qs.append("tag", String(params.tag));
	qs.set("sort", String(params.sort || "dateModified"));
	qs.set("direction", String(params.direction || "desc"));
	return qs.toString();
}

function dateMs(value: unknown): number | undefined {
	if (!value || typeof value !== "string") return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

function localDateStart(daysAgo = 0): Date {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - daysAgo);
	return d;
}

function passesDateFilters(entry: any, params: Record<string, unknown>): boolean {
	const data = entry.data || entry;
	const added = dateMs(data.dateAdded);
	const modified = dateMs(data.dateModified);
	let addedAfter = params.addedAfter ? dateMs(String(params.addedAfter)) : undefined;
	if (params.recentDays !== undefined) addedAfter = localDateStart(Math.max(0, Number(params.recentDays) - 1)).getTime();
	const addedBefore = params.addedBefore ? dateMs(String(params.addedBefore)) : undefined;
	const modifiedAfter = params.modifiedAfter ? dateMs(String(params.modifiedAfter)) : undefined;
	const modifiedBefore = params.modifiedBefore ? dateMs(String(params.modifiedBefore)) : undefined;
	if (addedAfter !== undefined && (added === undefined || added < addedAfter)) return false;
	if (addedBefore !== undefined && (added === undefined || added > addedBefore)) return false;
	if (modifiedAfter !== undefined && (modified === undefined || modified < modifiedAfter)) return false;
	if (modifiedBefore !== undefined && (modified === undefined || modified > modifiedBefore)) return false;
	return true;
}

function sortAcrossLibraries(items: any[], sort: unknown, direction: unknown): any[] {
	const field = String(sort || "dateModified");
	const dir = String(direction || "desc") === "asc" ? 1 : -1;
	return [...items].sort((a, b) => {
		const av = (a.data || a)[field];
		const bv = (b.data || b)[field];
		const am = dateMs(av);
		const bm = dateMs(bv);
		if (am !== undefined || bm !== undefined) return ((am || 0) - (bm || 0)) * dir;
		return String(av || "").localeCompare(String(bv || "")) * dir;
	});
}

function rankedLibrariesForSearch(libs: Library[], query: unknown): Library[] {
	const terms = String(query || "").toLowerCase().split(/\W+/).filter((x) => x.length >= 3);
	return [...libs].sort((a, b) => {
		const score = (lib: Library) => terms.reduce((n, term) => n + (lib.label.toLowerCase().includes(term) ? 1 : 0), 0);
		return score(b) - score(a);
	});
}

async function searchLibrariesWithBudget(libs: Library[], basePath: string, query: string, signal?: AbortSignal): Promise<{ all: any[]; totals: Record<string, string>; timedOut: string[] }> {
	const all: any[] = [];
	const totals: Record<string, string> = {};
	const timedOut: string[] = [];
	const deadline = Date.now() + zoteroSearchBudgetMs();
	let index = 0;
	const workerCount = Math.min(zoteroConcurrency(), libs.length);
	async function worker() {
		while (Date.now() < deadline && !signal?.aborted) {
			const lib = libs[index++];
			if (!lib) return;
			try {
				const timeLeft = Math.max(1000, deadline - Date.now());
				// All-library search is a discovery path: bypass the global retry/backoff queue so one
				// slow/backed-off request cannot starve every other library. This mirrors the MCP repo's
				// simple scoped-client fan-out, while keeping a short per-request timeout and budget.
				const { data, headers } = await directZoteroRequest(`${libraryPath(lib)}${basePath}?${query}`, { timeoutMs: Math.min(zoteroSearchRequestTimeoutMs(), timeLeft) }, signal);
				totals[lib.label] = headers["total-results"] || "?";
				if (Array.isArray(data)) all.push(...data.map((item) => ({ ...item, library: lib, libraryLabel: lib.label })));
			} catch (e) {
				const message = String((e as Error).message || e);
				if (message.toLowerCase().includes("abort") || message.toLowerCase().includes("timeout")) timedOut.push(lib.label);
				else all.push({ data: { title: `Error querying ${lib.label}: ${message}`, itemType: "error", key: "" }, libraryLabel: lib.label });
			}
		}
	}
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	for (let i = index; i < libs.length; i++) timedOut.push(libs[i].label);
	return { all, totals, timedOut };
}

async function resolveCollectionKey(lib: Library, collection: unknown, signal?: AbortSignal): Promise<string | undefined> {
	const value = String(collection || "").trim();
	if (!value) return undefined;
	if (/^[A-Z0-9]{8}$/.test(value)) return value;
	const lowered = value.toLowerCase();
	const matches: any[] = [];
	for (let start = 0; ; start += 100) {
		const qs = new URLSearchParams({ format: "json", limit: "100", start: String(start), sort: "title", direction: "asc" });
		const { data } = await zoteroRequest(lib, `/collections?${qs.toString()}`, { timeoutMs: 30000 }, signal);
		const page = Array.isArray(data) ? data : [];
		for (const c of page) {
			const name = c.data?.name || c.name || "";
			if (name.toLowerCase() === lowered) return c.key || c.data?.key;
			if (name.toLowerCase().includes(lowered)) matches.push(c);
		}
		if (page.length < 100) break;
	}
	if (matches.length === 1) return matches[0].key || matches[0].data?.key;
	if (matches.length > 1) throw new Error(`Multiple collections matched ${value}: ${matches.slice(0, 8).map((c) => `${c.data?.name || c.name} (${c.key || c.data?.key})`).join("; ")}`);
	throw new Error(`No collection matched ${value} in ${lib.label}.`);
}

function itemListPath(collectionKey: string | undefined, topLevelOnly = true): string {
	if (collectionKey) return `/collections/${encodeURIComponent(collectionKey)}/items${topLevelOnly ? "/top" : ""}`;
	return `/items${topLevelOnly ? "/top" : ""}`;
}

async function findSourcesInLibrary(lib: Library, params: Record<string, unknown>, signal?: AbortSignal): Promise<{ items: any[]; total: string; library: Library }> {
	const limit = Math.max(1, Math.min(Number(params.limit || 8), 100));
	const collectionKey = await resolveCollectionKey(lib, params.collection || params.collectionKey, signal);
	const q = String(params.citationKey || params.query || "").trim();
	const qs = new URLSearchParams();
	qs.set("format", "json");
	qs.set("include", "data");
	qs.set("limit", String(limit));
	qs.set("start", String(Math.max(0, Number(params.offset ?? params.start ?? 0))));
	qs.set("sort", String(params.sort || "dateModified"));
	qs.set("direction", String(params.direction || "desc"));
	if (params.itemType || params.item_type) qs.set("itemType", String(params.itemType || params.item_type));
	if (params.tag) qs.set("tag", String(params.tag));
	if (params.includeTrashed || params.include_trashed) qs.set("includeTrashed", "1");
	if (q && q !== "*") { qs.set("q", q); qs.set("qmode", String(params.citationKey ? "everything" : params.qmode || "titleCreatorYear")); }
	const { data, headers } = await zoteroRequest(lib, `${itemListPath(collectionKey, true)}?${qs.toString()}`, { timeoutMs: 30000 }, signal);
	let items = Array.isArray(data) ? data.map((item) => ({ ...item, library: lib, libraryLabel: lib.label })) : [];
	if (params.citationKey) {
		const needle = `Citation Key: ${String(params.citationKey).trim().replace(/^Citation Key:\s*/, "")}`;
		items = items.filter((item) => String((item.data || item).extra || "").includes(needle));
	}
	return { items, total: headers["total-results"] || String(items.length), library: lib };
}

async function fetchCrossref(doi: string, signal?: AbortSignal): Promise<Partial<ZoteroItemInput>> {
	const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { signal });
	if (!res.ok) throw new Error(`Crossref lookup failed (${res.status}) for DOI ${doi}`);
	const json: any = await res.json();
	const m = json.message || {};
	return {
		itemType: "journalArticle",
		title: Array.isArray(m.title) ? m.title[0] : undefined,
		date: m.published?.["date-parts"]?.[0]?.join("-") || m.issued?.["date-parts"]?.[0]?.join("-"),
		doi: m.DOI || doi,
		url: m.URL,
		publicationTitle: Array.isArray(m["container-title"]) ? m["container-title"][0] : undefined,
		abstractNote: m.abstract,
		creators: (m.author || []).map((a: any) => ({ firstName: a.given, lastName: a.family, creatorType: "author" })),
	};
}

async function targetLibrary(input: ZoteroItemInput, signal?: AbortSignal): Promise<Library> {
	if (input.libraryKind && input.libraryId) return { kind: input.libraryKind, id: input.libraryId, label: `${input.libraryKind}/${input.libraryId}` };
	const libs = await getLibraries(signal);
	return libs[0];
}

async function createZoteroItem(input: ZoteroItemInput, signal?: AbortSignal): Promise<any> {
	let item: ZoteroItemInput = { ...input };
	if (item.doi && !item.title) item = { ...(await fetchCrossref(item.doi, signal)), ...item };
	if (!item.title) throw new Error("zotero_add needs at least title, or a DOI that Crossref can resolve.");
	const zoteroItem: Record<string, unknown> = { itemType: item.itemType || "journalArticle", title: item.title };
	if (item.creators?.length) zoteroItem.creators = item.creators.map((c) => c.name ? { name: c.name, creatorType: c.creatorType || "author" } : { firstName: c.firstName || "", lastName: c.lastName || "", creatorType: c.creatorType || "author" });
	if (item.date) zoteroItem.date = item.date;
	if (item.doi) zoteroItem.DOI = item.doi;
	if (item.url) zoteroItem.url = item.url;
	if (item.publicationTitle) zoteroItem.publicationTitle = item.publicationTitle;
	if (item.abstractNote) zoteroItem.abstractNote = item.abstractNote;
	if (item.tags?.length) zoteroItem.tags = item.tags.map((tag) => ({ tag }));
	if (item.collections?.length) zoteroItem.collections = item.collections;
	const lib = await targetLibrary(item, signal);
	const result = await zoteroRequest(lib, "/items", { method: "POST", body: JSON.stringify([zoteroItem]) }, signal);
	return { library: lib.label, result: result.data };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "zotero_libraries",
		label: "Zotero Libraries",
		description: "List every Zotero user/group library accessible with the configured API key.",
		promptSnippet: "List all Zotero libraries accessible by the API key",
		promptGuidelines: ["Use zotero_libraries when the user asks what Zotero libraries/groups are available."],
		parameters: Type.Object({}),
		async execute(_id, _params, signal) {
			const libraries = await getLibraries(signal);
			return { content: [{ type: "text", text: libraries.map((l) => `- ${l.label}`).join("\n") }], details: { libraries } };
		},
	});

	pi.registerTool({
		name: "zotero_find_sources",
		label: "Zotero Find Sources",
		description: "Find compact bibliographic source summaries in one Zotero library, using MCP-style library/name resolution.",
		promptSnippet: "Find relevant Zotero papers in a specific library with compact metadata",
		promptGuidelines: [
			"Prefer zotero_find_sources for normal research discovery when the user names or implies one library.",
			"The library parameter accepts personal, group names, numeric group IDs, or group/<id>. Omit it for the personal/default library.",
			"Use query='*' to list sources with only tag/collection filters.",
			"Use citationKey to search Better BibTeX citation keys stored in the Extra field.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search text. Use '*' to list items without a text query." }),
			library: Type.Optional(Type.String({ description: "Library: personal, group name, numeric group ID, or group/<id>. Default personal/default." })),
			limit: Type.Optional(Type.Number({ description: "Max results, 1-100. Default 8." })),
			offset: Type.Optional(Type.Number({ description: "Pagination offset. Default 0." })),
			collection: Type.Optional(Type.String({ description: "Optional collection name or key." })),
			itemType: Type.Optional(Type.String({ description: "Optional Zotero item type, e.g. journalArticle, conferencePaper, book." })),
			tag: Type.Optional(Type.String({ description: "Optional exact tag filter." })),
			citationKey: Type.Optional(Type.String({ description: "Optional Better BibTeX citation key. Searches Extra for 'Citation Key: <key>'." })),
			qmode: Type.Optional(Type.String({ description: "titleCreatorYear (default) or everything." })),
			includeTrashed: Type.Optional(Type.Boolean({ description: "Include trashed items. Default false." })),
		}),
		async execute(_id, params, signal) {
			if (!String(params.query || "").trim() && !params.citationKey) throw new Error("query must not be empty unless citationKey is provided.");
			const lib = await resolveLibrarySpec(params.library, signal);
			const result = await findSourcesInLibrary(lib, params as Record<string, unknown>, signal);
			const text = result.items.length ? result.items.map(formatSourceSummary).join("\n\n") : "No Zotero sources found.";
			return { content: [{ type: "text", text: truncate(text) }], details: { library: lib, count: result.items.length, total_results: result.total, sources: result.items.map(sourceSummary) } };
		},
	});

	pi.registerTool({
		name: "zotero_search_across_libraries",
		label: "Zotero Search Across Libraries",
		description: "Search compact source summaries across multiple named Zotero libraries or all libraries.",
		promptSnippet: "Search for sources across multiple Zotero libraries",
		promptGuidelines: [
			"Use this when the user explicitly wants multiple libraries checked.",
			"Pass libraries as comma-separated names/IDs, or 'all' for every accessible library.",
			"For ordinary discovery, prefer zotero_find_sources in a specific library first.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search text." }),
			libraries: Type.Optional(Type.String({ description: "Comma-separated libraries, or 'all'. Default all." })),
			limit: Type.Optional(Type.Number({ description: "Max results per library/all-library page. Default 8." })),
			itemType: Type.Optional(Type.String({ description: "Optional Zotero item type filter." })),
			tag: Type.Optional(Type.String({ description: "Optional exact tag filter." })),
			qmode: Type.Optional(Type.String({ description: "titleCreatorYear (default) or everything." })),
		}),
		async execute(_id, params, signal) {
			if (!String(params.query || "").trim()) throw new Error("query must not be empty.");
			const libs = await resolveLibraryList(params.libraries || "all", signal);
			const perLibraryLimit = Math.max(1, Math.min(Number(params.limit || 8), 100));
			const query = buildQuery({ ...params, limit: perLibraryLimit, itemType: params.itemType || undefined }, perLibraryLimit);
			const { all, totals, timedOut } = await searchLibrariesWithBudget(rankedLibrariesForSearch(libs, params.query), "/items/top", query, signal);
			const items = sortAcrossLibraries(all.filter((x) => x.data?.itemType !== "error"), "dateModified", "desc").slice(0, Math.max(1, Math.min(Number(params.limit || 25), 100)));
			let text = items.length ? items.map(formatSourceSummary).join("\n\n") : "No Zotero sources found.";
			if (timedOut.length) text += `\n\nPartial results: timed out/skipped ${timedOut.length} libraries: ${timedOut.slice(0, 8).join(", ")}${timedOut.length > 8 ? ", ..." : ""}`;
			return { content: [{ type: "text", text: truncate(text) }], details: { count: items.length, totals, timedOut, sources: items.map(sourceSummary), libraries: libs } };
		},
	});

	pi.registerTool({
		name: "zotero_library_count",
		label: "Zotero Library Count",
		description: "Count items in a Zotero library, top-level sources by default.",
		promptSnippet: "Count items in a Zotero library",
		promptGuidelines: ["Use when the user asks how many items/sources are in a library or group."],
		parameters: Type.Object({
			library: Type.Optional(Type.String({ description: "Library: personal, group name, numeric group ID, or group/<id>. Default personal/default." })),
			includeAttachmentsAndNotes: Type.Optional(Type.Boolean({ description: "When true, count all items including PDFs/notes. Default false." })),
		}),
		async execute(_id, params, signal) {
			const lib = await resolveLibrarySpec(params.library, signal);
			const path = params.includeAttachmentsAndNotes ? "/items" : "/items/top";
			const qs = new URLSearchParams({ format: "json", limit: "1", include: "data" });
			const { headers } = await zoteroRequest(lib, `${path}?${qs.toString()}`, { timeoutMs: 30000 }, signal);
			const total = headers["total-results"] || "?";
			return { content: [{ type: "text", text: `${lib.label}: ${total} item${total === "1" ? "" : "s"}${params.includeAttachmentsAndNotes ? " including attachments/notes" : " (top-level sources only)"}.` }], details: { library: lib, total_items: total, includes_attachments_and_notes: !!params.includeAttachmentsAndNotes } };
		},
	});

	pi.registerTool({
		name: "zotero_search",
		label: "Zotero Search All Remote Libraries",
		description: "Search/query all Zotero user and group libraries accessible with the Zotero API key.",
		promptSnippet: "Search/query all accessible Zotero libraries remotely via Zotero API",
		promptGuidelines: [
			"Use zotero_search when the user asks to find papers/books/resources in their Zotero library.",
			"zotero_search queries all remote Zotero libraries accessible by the API key, unless libraryKind/libraryId is specified.",
			"For 'last N added' requests, call zotero_search with sort='dateAdded', direction='desc', limit=N; add recentDays=1 for items added today.",
			"Use zotero_get with both key and library info from search results when full metadata or child notes/attachments are needed.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search text. Omit to list recent items." })),
			library: Type.Optional(Type.String({ description: "Optional library spec: personal, group name, numeric group ID, group/<id>, or comma-separated list. Omit/all searches all libraries." })),
			qmode: Type.Optional(Type.String({ description: "Zotero query mode: titleCreatorYear (default, faster) or everything (broader, slower)." })),
			limit: Type.Optional(Type.Number({ description: "Total maximum results, 1-100. Default 25." })),
			start: Type.Optional(Type.Number({ description: "Per-library pagination offset. Default 0." })),
			itemType: Type.Optional(Type.String({ description: "Optional item type filter, e.g. journalArticle, book. Defaults to -attachment to avoid child PDFs." })),
			tag: Type.Optional(Type.String({ description: "Optional tag filter." })),
			addedAfter: Type.Optional(Type.String({ description: "Client-side filter: only items added after this date/time, e.g. 2026-05-01 or 2026-05-01T00:00:00." })),
			addedBefore: Type.Optional(Type.String({ description: "Client-side filter: only items added before this date/time." })),
			modifiedAfter: Type.Optional(Type.String({ description: "Client-side filter: only items modified after this date/time." })),
			modifiedBefore: Type.Optional(Type.String({ description: "Client-side filter: only items modified before this date/time." })),
			recentDays: Type.Optional(Type.Number({ description: "Client-side filter by dateAdded: 1 means added today, 7 means added since local midnight 6 days ago." })),
			collectionKey: Type.Optional(Type.String({ description: "Optional collection key. Searches items inside that collection for each/selected library." })),
			libraryKind: Type.Optional(Type.String({ description: "Optional: user or group. If set, libraryId is required and only that library is queried." })),
			libraryId: Type.Optional(Type.String({ description: "Optional user/group numeric ID to restrict the search." })),
			sort: Type.Optional(Type.String({ description: "Zotero sort field. Default dateModified." })),
			direction: Type.Optional(Type.String({ description: "asc or desc. Default desc." })),
		}),
		async execute(_id, params, signal) {
			const totalLimit = Math.max(1, Math.min(Number(params.limit || 25), 100));
			const libs = params.libraryKind && params.libraryId
				? [{ kind: params.libraryKind as "user" | "group", id: params.libraryId, label: `${params.libraryKind}/${params.libraryId}` }]
				: params.library ? await resolveLibraryList(params.library, signal) : await getLibraries(signal);
			// Fetch up to totalLimit per library, then sort/filter globally. This makes requests like
			// "last 5 items added across all libraries" accurate instead of taking only 1 per library.
			const perLibraryLimit = totalLimit;
			const query = buildQuery(params as Record<string, unknown>, perLibraryLimit);
			// Search top-level bibliographic items by default, like strato-mcp-zotero does.
			// This avoids wasting all-library requests on PDFs, snapshots, and notes.
			const basePath = params.collectionKey ? `/collections/${encodeURIComponent(params.collectionKey)}/items/top` : "/items/top";
			let all: any[] = [];
			let totals: Record<string, string> = {};
			let timedOut: string[] = [];
			if ((params.libraryKind && params.libraryId) || (params.library && libs.length === 1)) {
				try {
					const lib = libs[0];
					const { data, headers } = await zoteroRequest(lib, `${basePath}?${query}`, { timeoutMs: Math.max(zoteroRequestTimeoutMs(), 30000) }, signal);
					totals[lib.label] = headers["total-results"] || "?";
					if (Array.isArray(data)) all = data.map((item) => ({ ...item, library: lib, libraryLabel: lib.label }));
				} catch (e) {
					all.push({ data: { title: `Error querying ${libs[0].label}: ${(e as Error).message || e}`, itemType: "error", key: "" }, libraryLabel: libs[0].label });
				}
			} else {
				const rankedLibs = rankedLibrariesForSearch(libs, params.query);
				({ all, totals, timedOut } = await searchLibrariesWithBudget(rankedLibs, basePath, query, signal));
			}
			const filtered = all.filter((x) => x.data?.itemType !== "error" && passesDateFilters(x, params as Record<string, unknown>));
			const items = sortAcrossLibraries(filtered, params.sort, params.direction).slice(0, totalLimit);
			const errors = all.filter((x) => x.data?.itemType === "error");
			const outputItems = [...items, ...errors];
			let text = outputItems.length ? outputItems.map(formatItem).join("\n\n") : "No Zotero items found.";
			if (timedOut.length) text += `\n\nNote: Zotero search returned partial results. Timed out or skipped ${timedOut.length} librar${timedOut.length === 1 ? "y" : "ies"}: ${timedOut.slice(0, 8).join(", ")}${timedOut.length > 8 ? ", ..." : ""}`;
			return { content: [{ type: "text", text: truncate(text) }], details: { items, errors, totals, timedOut, libraries: libs } };
		},
	});

	pi.registerTool({
		name: "zotero_get",
		label: "Zotero Get Remote Item",
		description: "Get complete metadata for one Zotero item by key from all accessible libraries, or a specified library.",
		promptSnippet: "Retrieve a specific Zotero item remotely by key from all libraries",
		promptGuidelines: ["Use zotero_get after zotero_search when full metadata or child notes/attachments are needed. Pass libraryKind/libraryId if known."],
		parameters: Type.Object({
			key: Type.String({ description: "Zotero item key, e.g. ABCD1234." }),
			library: Type.Optional(Type.String({ description: "Optional library spec: personal, group name, numeric group ID, or group/<id>." })),
			libraryKind: Type.Optional(Type.String({ description: "Optional: user or group." })),
			libraryId: Type.Optional(Type.String({ description: "Optional user/group numeric ID." })),
			includeChildren: Type.Optional(Type.Boolean({ description: "Also fetch child notes/attachments. Default true." })),
		}),
		async execute(_id, params, signal) {
			const libs = params.libraryKind && params.libraryId
				? [{ kind: params.libraryKind as "user" | "group", id: params.libraryId, label: `${params.libraryKind}/${params.libraryId}` }]
				: params.library ? [await resolveLibrarySpec(params.library, signal)] : await getLibraries(signal);
			const matches: any[] = [];
			for (const lib of libs) {
				try {
					const item = (await zoteroRequest(lib, `/items/${encodeURIComponent(params.key)}?format=json&include=data,bib`, {}, signal)).data;
					let children: any[] | undefined;
					if (params.includeChildren !== false) children = (await zoteroRequest(lib, `/items/${encodeURIComponent(params.key)}/children?format=json&include=data`, {}, signal)).data;
					matches.push({ library: lib, item, children });
				} catch (e) {
					if (!String((e as Error).message).includes("404")) matches.push({ library: lib, error: (e as Error).message });
				}
			}
			if (!matches.length) return { content: [{ type: "text", text: `No Zotero item found with key ${params.key} in accessible libraries.` }], details: { matches: [] } };
			return { content: [{ type: "text", text: truncate(JSON.stringify({ matches }, null, 2)) }], details: { matches } };
		},
	});

	pi.registerTool({
		name: "zotero_collections",
		label: "Zotero Collections All Libraries",
		description: "List Zotero collections across all accessible user/group libraries.",
		promptSnippet: "List Zotero collections and keys across all accessible libraries",
		promptGuidelines: ["Use zotero_collections when collection keys are needed for zotero_search or zotero_add."],
		parameters: Type.Object({
			limit: Type.Optional(Type.Number({ description: "Per-library collection limit, 1-100. Default 100." })),
			start: Type.Optional(Type.Number({ description: "Per-library pagination offset. Default 0." })),
		}),
		async execute(_id, params, signal) {
			const libs = await getLibraries(signal);
			const qs = new URLSearchParams({ format: "json", limit: String(Math.max(1, Math.min(Number(params.limit || 100), 100))) });
			if (params.start !== undefined) qs.set("start", String(params.start));
			const collections: any[] = [];
			const results = await Promise.allSettled(libs.map(async (lib) => ({ lib, ...(await zoteroRequest(lib, `/collections?${qs.toString()}`, {}, signal)) })));
			for (const result of results) {
				if (result.status === "fulfilled" && Array.isArray(result.value.data)) {
					collections.push(...result.value.data.map((c) => ({ ...c, library: result.value.lib, libraryLabel: result.value.lib.label })));
				}
			}
			const text = collections.length
				? collections.map((c: any) => `- ${c.data?.name || c.name}\n  Library: ${c.libraryLabel}\n  Key: ${c.key || c.data?.key}\n  Parent: ${c.data?.parentCollection || "(none)"}`).join("\n\n")
				: "No Zotero collections found.";
			return { content: [{ type: "text", text: truncate(text) }], details: { collections, libraries: libs } };
		},
	});

	pi.registerTool({
		name: "zotero_add",
		label: "Zotero Add Remote Item",
		description: "Add a new bibliographic resource to Zotero through the Web API. Defaults to the first accessible library unless libraryKind/libraryId are provided.",
		promptSnippet: "Add/create new resources in Zotero remotely via Zotero API",
		promptGuidelines: [
			"Use zotero_add when the user asks to add a resource to Zotero.",
			"If the user has multiple libraries, ask which library to add to or pass libraryKind/libraryId explicitly.",
			"For DOI-only adds, pass doi; the tool will fetch metadata from Crossref.",
		],
		parameters: Type.Object({
			itemType: Type.Optional(Type.String({ description: "Zotero item type, e.g. journalArticle, book, webPage. Default journalArticle." })),
			title: Type.Optional(Type.String({ description: "Title. Required unless doi is resolvable through Crossref." })),
			creators: Type.Optional(Type.Array(Type.Object({ firstName: Type.Optional(Type.String()), lastName: Type.Optional(Type.String()), name: Type.Optional(Type.String()), creatorType: Type.Optional(Type.String()) }))),
			date: Type.Optional(Type.String()), doi: Type.Optional(Type.String()), url: Type.Optional(Type.String()), publicationTitle: Type.Optional(Type.String()), abstractNote: Type.Optional(Type.String()),
			tags: Type.Optional(Type.Array(Type.String())), collections: Type.Optional(Type.Array(Type.String({ description: "Zotero collection keys." }))),
			libraryKind: Type.Optional(Type.String({ description: "Optional target: user or group." })), libraryId: Type.Optional(Type.String({ description: "Optional target user/group numeric ID." })),
		}),
		async execute(_id, params, signal) {
			const data = await createZoteroItem(params, signal);
			return { content: [{ type: "text", text: `Created Zotero item remotely.\n${JSON.stringify(data, null, 2)}` }], details: data };
		},
	});
}
