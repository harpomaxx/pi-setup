import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Library = { kind: "user" | "group"; id: string; label: string };
type Creator = { firstName?: string; lastName?: string; name?: string; creatorType?: string };
type ZoteroItemInput = {
	itemType?: string; title?: string; creators?: Creator[]; date?: string; doi?: string; url?: string;
	publicationTitle?: string; abstractNote?: string; tags?: string[]; collections?: string[];
	libraryKind?: "user" | "group"; libraryId?: string;
};

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

async function rawZoteroRequest(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<{ data: any; headers: Record<string, string> }> {
	const res = await fetch(`https://api.zotero.org${path}`, {
		...init,
		signal: withTimeout(signal),
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
	if (!res.ok) {
		if (res.status === 401 || res.status === 403) throw new Error(`Zotero authorization failed (${res.status}). Check ZOTERO_API_KEY permissions.`);
		if (res.status === 404) throw new Error(`Zotero resource not found (404): ${path}`);
		if (res.status === 429) throw new Error("Zotero API rate limited this request (429). Try again later.");
		throw new Error(`Zotero API error (${res.status}): ${typeof data === "string" ? data : JSON.stringify(data).slice(0, 1000)}`);
	}
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => { headers[k] = v; });
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

async function zoteroRequest(lib: Library, path: string, init: RequestInit = {}, signal?: AbortSignal) {
	return rawZoteroRequest(`${libraryPath(lib)}${path}`, init, signal);
}

function creatorsToText(creators: any[] | undefined): string {
	return (creators || []).map((c) => c.name || [c.firstName, c.lastName].filter(Boolean).join(" ")).filter(Boolean).slice(0, 8).join("; ");
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

function buildQuery(params: Record<string, unknown>, perLibraryLimit: number): string {
	const qs = new URLSearchParams();
	qs.set("format", "json");
	qs.set("include", "data");
	qs.set("limit", String(perLibraryLimit));
	if (params.start !== undefined) qs.set("start", String(params.start));
	if (params.query) { qs.set("q", String(params.query)); qs.set("qmode", String(params.qmode || "everything")); }
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
			qmode: Type.Optional(Type.String({ description: "Zotero query mode: everything (default) or titleCreatorYear." })),
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
				: await getLibraries(signal);
			// Fetch up to totalLimit per library, then sort/filter globally. This makes requests like
			// "last 5 items added across all libraries" accurate instead of taking only 1 per library.
			const perLibraryLimit = totalLimit;
			const query = buildQuery(params as Record<string, unknown>, perLibraryLimit);
			const all: any[] = [];
			const totals: Record<string, string> = {};
			const basePath = params.collectionKey ? `/collections/${encodeURIComponent(params.collectionKey)}/items` : "/items";
			const results = await Promise.allSettled(libs.map(async (lib) => ({ lib, ...(await zoteroRequest(lib, `${basePath}?${query}`, {}, signal)) })));
			for (const result of results) {
				if (result.status === "fulfilled") {
					const { lib, data, headers } = result.value;
					totals[lib.label] = headers["total-results"] || "?";
					if (Array.isArray(data)) all.push(...data.map((item) => ({ ...item, library: lib, libraryLabel: lib.label })));
				} else {
					all.push({ data: { title: `Error querying a Zotero library: ${result.reason?.message || result.reason}`, itemType: "error", key: "" }, libraryLabel: "?" });
				}
			}
			const filtered = all.filter((x) => x.data?.itemType !== "error" && passesDateFilters(x, params as Record<string, unknown>));
			const items = sortAcrossLibraries(filtered, params.sort, params.direction).slice(0, totalLimit);
			const errors = all.filter((x) => x.data?.itemType === "error");
			const outputItems = [...items, ...errors];
			const text = outputItems.length ? outputItems.map(formatItem).join("\n\n") : "No Zotero items found.";
			return { content: [{ type: "text", text: truncate(text) }], details: { items, errors, totals, libraries: libs } };
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
			libraryKind: Type.Optional(Type.String({ description: "Optional: user or group." })),
			libraryId: Type.Optional(Type.String({ description: "Optional user/group numeric ID." })),
			includeChildren: Type.Optional(Type.Boolean({ description: "Also fetch child notes/attachments. Default true." })),
		}),
		async execute(_id, params, signal) {
			const libs = params.libraryKind && params.libraryId
				? [{ kind: params.libraryKind as "user" | "group", id: params.libraryId, label: `${params.libraryKind}/${params.libraryId}` }]
				: await getLibraries(signal);
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
