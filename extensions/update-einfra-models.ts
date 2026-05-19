import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_MODELS_JSON = "~/.pi/agent/models.json";
const DEFAULT_PROVIDER = "e-infra.cz";
const JSON_INDENTATION = 4;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const NON_CHAT_MODEL_RE = /(embed|embedding|rerank|e5|mxbai|nomic|whisper)/i;

const CONTEXT_WINDOWS_BY_MODEL_ID: Record<string, number> = {
    // e-INFRA documented current/guaranteed models.
    "gpt-oss-120b": 128_000,
    "deepseek-v4-pro": 1_000_000,
    "deepseek-v4-pro-thinking": 1_000_000,
    "qwen3.5-122b": 256_000,
    "glm-5": 200_000,
    "glm-5.1": 200_000,
    "kimi-k2.6": 256_000,
    "qwen3.5": 262_000,
    "mistral-medium-3.5": 262_000,

    // Older/deprecated aliases still returned by /models.
    "deepseek-v3.2": 128_000,
    "deepseek-v3.2-thinking": 128_000,
    "kimi-k2.5": 256_000,
    "qwen3-coder": 256_000,
    "qwen3-coder-30b": 256_000,
    "qwen3-coder-next": 256_000,
    "llama-4-scout-17b-16e-instruct": 10_000_000,
    "redhatai-scout": 10_000_000,
    "gemma4": 128_000,
    "glm-4.7": 128_000,
    mini: 128_000,
    coder: 256_000,
    agentic: 256_000,
    thinker: 128_000,

    // Non-chat models, used only when includeNonChatModels=true.
    "qwen3-embedding-4b": 40_960,
    "qwen3-reranker-4b": 40_960,
    "nomic-embed-text-v1.5": 512,
    "nomic-embed-text-v2-moe": 512,
    "mxbai-embed-large:latest": 512,
    "multilingual-e5-large-instruct": 514,
    "whisper-large-v3": 128_000,
};

const updateEinfraModelsSchema = Type.Object({
    modelsJsonPath: Type.Optional(
        Type.String({
            description: "Path to models.json. Defaults to ~/.pi/agent/models.json.",
        }),
    ),
    providerName: Type.Optional(
        Type.String({
            description: "Provider key in models.json. Defaults to e-infra.cz.",
        }),
    ),
    includeNonChatModels: Type.Optional(
        Type.Boolean({
            description:
                "Include embedding/reranker models returned by /models. Defaults to false because pi needs chat/completion models.",
        }),
    ),
    dryRun: Type.Optional(
        Type.Boolean({ description: "Show changes without writing models.json. Defaults to false." }),
    ),
});

type UpdateEinfraModelsParams = {
    modelsJsonPath?: string;
    providerName?: string;
    includeNonChatModels?: boolean;
    dryRun?: boolean;
};

type ModelsJson = {
    providers?: Record<string, ProviderConfig>;
};

type ProviderConfig = {
    baseUrl?: string;
    apiKey?: string;
    models?: ModelConfig[];
    [key: string]: unknown;
};

type ModelConfig = {
    id: string;
    name?: string;
    contextWindow?: number;
    [key: string]: unknown;
};

type FetchedModel = {
    id: string;
    contextWindow?: number;
};

function expandPath(path: string): string {
    if (path === "~") return homedir();
    if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
    return resolve(path);
}

function curlJson(url: string, apiKey: string, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
        const child = execFile(
            "curl",
            ["-fsS", "-H", `Authorization: Bearer ${apiKey}`, url],
            { timeout: 30_000, maxBuffer: 10 * 1024 * 1024, signal },
            (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(`curl failed: ${stderr.trim() || error.message}`));
                    return;
                }
                try {
                    resolvePromise(JSON.parse(stdout));
                } catch (parseError) {
                    reject(
                        new Error(
                            `Could not parse /models JSON: ${
                                parseError instanceof Error ? parseError.message : String(parseError)
                            }`,
                        ),
                    );
                }
            },
        );

        child.on("error", (error) => reject(error));
    });
}

function parseContextWindow(value: string): number | undefined {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
    if (!match) return undefined;
    const base = Number(match[1]);
    if (!Number.isFinite(base) || base <= 0) return undefined;
    const suffix = match[2]?.toLowerCase();
    if (suffix === "m") return Math.round(base * 1_000_000);
    if (suffix === "k") return Math.round(base * 1_000);
    return Math.round(base);
}

function readNumericField(item: Record<string, unknown>, fieldNames: string[]): number | undefined {
    for (const fieldName of fieldNames) {
        const value = item[fieldName];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
        if (typeof value === "string") {
            const parsed = parseContextWindow(value);
            if (parsed) return parsed;
        }
    }
    return undefined;
}

function contextWindowForModel(id: string, apiContextWindow?: number): number {
    return apiContextWindow ?? CONTEXT_WINDOWS_BY_MODEL_ID[id] ?? inferContextWindow(id) ?? DEFAULT_CONTEXT_WINDOW;
}

function inferContextWindow(id: string): number | undefined {
    if (/deepseek-v4/i.test(id)) return 1_000_000;
    if (/llama-4-scout|redhatai-scout/i.test(id)) return 10_000_000;
    if (/qwen3\.5-122b/i.test(id)) return 256_000;
    if (/qwen3\.5|mistral-medium-3\.5/i.test(id)) return 262_000;
    if (/qwen3-coder|kimi-k2/i.test(id)) return 256_000;
    if (/glm-5/i.test(id)) return 200_000;
    if (/gpt-oss-120b|deepseek-v3\.2|gemma|glm-4/i.test(id)) return 128_000;
    if (/qwen3-(embedding|reranker)/i.test(id)) return 40_960;
    if (/nomic|mxbai/i.test(id)) return 512;
    if (/e5/i.test(id)) return 514;
    return undefined;
}

function modelsFromResponse(payload: unknown): FetchedModel[] {
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data)) throw new Error("/models response did not contain a data array");

    const models: FetchedModel[] = [];
    const seen = new Set<string>();
    for (const item of data) {
        const record = item as Record<string, unknown>;
        const id = record.id;
        if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
        seen.add(id);
        models.push({
            id,
            contextWindow: readNumericField(record, [
                "contextWindow",
                "context_window",
                "context_length",
                "contextLength",
                "max_context_length",
                "max_context_len",
                "max_model_len",
                "max_sequence_length",
            ]),
        });
    }
    return models;
}

async function updateModels(params: UpdateEinfraModelsParams, signal?: AbortSignal) {
    const modelsJsonPath = expandPath(params.modelsJsonPath ?? DEFAULT_MODELS_JSON);
    const providerName = params.providerName ?? DEFAULT_PROVIDER;
    const includeNonChatModels = params.includeNonChatModels ?? false;
    const dryRun = params.dryRun ?? false;

    const rawConfig = await readFile(modelsJsonPath, "utf8");
    const config = JSON.parse(rawConfig) as ModelsJson;
    const provider = config.providers?.[providerName];
    if (!provider) throw new Error(`Provider '${providerName}' not found in ${modelsJsonPath}`);
    if (!provider.baseUrl) throw new Error(`Provider '${providerName}' has no baseUrl`);
    if (!provider.apiKey) throw new Error(`Provider '${providerName}' has no apiKey`);

    const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
    const payload = await curlJson(endpoint, provider.apiKey, signal);
    const fetchedModels = modelsFromResponse(payload);
    const skippedIds = includeNonChatModels
        ? []
        : fetchedModels.filter((model) => NON_CHAT_MODEL_RE.test(model.id)).map((model) => model.id);
    const chatModels = includeNonChatModels
        ? fetchedModels
        : fetchedModels.filter((model) => !NON_CHAT_MODEL_RE.test(model.id));
    const chatIds = chatModels.map((model) => model.id);

    const existingModels = Array.isArray(provider.models) ? provider.models : [];
    const existingById = new Map(existingModels.map((model) => [model.id, model]));
    const existingIds = existingModels.map((model) => model.id);
    const contextWindows: Record<string, number> = {};
    const nextModels = chatModels.map((fetchedModel) => {
        const existingModel = existingById.get(fetchedModel.id);
        const contextWindow = contextWindowForModel(fetchedModel.id, fetchedModel.contextWindow);
        contextWindows[fetchedModel.id] = contextWindow;
        return {
            ...(existingModel ?? {}),
            id: fetchedModel.id,
            name: existingModel?.name ?? fetchedModel.id,
            contextWindow,
        };
    });

    const nextIdSet = new Set(chatIds);
    const existingIdSet = new Set(existingIds);
    const added = chatIds.filter((id) => !existingIdSet.has(id));
    const removed = existingIds.filter((id) => !nextIdSet.has(id));
    const kept = chatIds.filter((id) => existingIdSet.has(id));

    const nextConfig: ModelsJson = {
        ...config,
        providers: {
            ...config.providers,
            [providerName]: {
                ...provider,
                models: nextModels,
            },
        },
    };

    if (!dryRun) {
        await writeFile(modelsJsonPath, `${JSON.stringify(nextConfig, null, JSON_INDENTATION)}\n`, "utf8");
    }

    return {
        modelsJsonPath,
        providerName,
        endpoint,
        dryRun,
        added,
        removed,
        kept,
        skippedIds,
        contextWindows,
        total: nextModels.length,
    };
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "update_einfra_models",
        label: "Update e-infra.cz models",
        description:
            "Fetch the e-infra.cz OpenAI-compatible /models endpoint with curl and update the provider's models list in models.json.",
        promptSnippet: "Update ~/.pi/agent/models.json from the e-infra.cz /models API.",
        promptGuidelines: [
            "Use update_einfra_models when the user asks to refresh or update the e-infra.cz models in models.json.",
        ],
        parameters: updateEinfraModelsSchema,
        async execute(_toolCallId, params, signal) {
            const result = await updateModels(params, signal);
            const lines = [
                `${result.dryRun ? "Dry run" : "Updated"} ${result.providerName} in ${result.modelsJsonPath}.`,
                `Models now listed: ${result.total}`,
                `Context windows set: ${Object.keys(result.contextWindows).length}`,
                `Added: ${result.added.length ? result.added.join(", ") : "none"}`,
                `Removed: ${result.removed.length ? result.removed.join(", ") : "none"}`,
                `Skipped non-chat: ${result.skippedIds.length ? result.skippedIds.join(", ") : "none"}`,
            ];
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: result,
            };
        },
    });

    pi.registerCommand("update-einfra-models", {
        description: "Update ~/.pi/agent/models.json from e-infra.cz /models",
        handler: async (args, ctx) => {
            const dryRun = args.trim() === "--dry-run";
            try {
                const result = await updateModels({ dryRun }, ctx.signal);
                ctx.ui.notify(
                    `${dryRun ? "Dry run" : "Updated"} e-infra.cz models: ${result.total} listed, ${result.added.length} added, ${result.removed.length} removed, context windows set for ${Object.keys(result.contextWindows).length} models.`,
                    "success",
                );
            } catch (error) {
                ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            }
        },
    });
}
