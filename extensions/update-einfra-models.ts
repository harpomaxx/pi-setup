import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_MODELS_JSON = "~/.pi/agent/models.json";
const DEFAULT_PROVIDER = "e-infra.cz";
const NON_CHAT_MODEL_RE = /(embed|embedding|rerank|e5|mxbai|nomic)/i;

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
  [key: string]: unknown;
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
              `Could not parse /models JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
            ),
          );
        }
      },
    );

    child.on("error", (error) => reject(error));
  });
}

function modelIdsFromResponse(payload: unknown): string[] {
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("/models response did not contain a data array");

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
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
  const fetchedIds = modelIdsFromResponse(payload);
  const skippedIds = includeNonChatModels ? [] : fetchedIds.filter((id) => NON_CHAT_MODEL_RE.test(id));
  const chatIds = includeNonChatModels ? fetchedIds : fetchedIds.filter((id) => !NON_CHAT_MODEL_RE.test(id));

  const existingModels = Array.isArray(provider.models) ? provider.models : [];
  const existingById = new Map(existingModels.map((model) => [model.id, model]));
  const existingIds = existingModels.map((model) => model.id);
  const nextModels = chatIds.map((id) => ({ ...(existingById.get(id) ?? {}), id, name: existingById.get(id)?.name ?? id }));

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
    await writeFile(modelsJsonPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
  }

  return { modelsJsonPath, providerName, endpoint, dryRun, added, removed, kept, skippedIds, total: nextModels.length };
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
          `${dryRun ? "Dry run" : "Updated"} e-infra.cz models: ${result.total} listed, ${result.added.length} added, ${result.removed.length} removed.`,
          "success",
        );
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
