import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_DIR = join(homedir(), ".config", "pi-google-docs");
const DEFAULT_CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");
const DEFAULT_TOKEN_FILE = join(CONFIG_DIR, "token.json");
const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
];

type CredentialsJson = {
  installed?: { client_id?: string; client_secret?: string; redirect_uris?: string[] };
  web?: { client_id?: string; client_secret?: string; redirect_uris?: string[] };
};

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function extractDocumentId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/) || trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? trimmed;
}

function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/) || trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? trimmed;
}

function loadOAuthConfig() {
  const rawJson = process.env.GOOGLE_OAUTH_CREDENTIALS_JSON;
  let creds: CredentialsJson | undefined;

  if (rawJson) {
    creds = JSON.parse(rawJson);
  } else if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    creds = {
      installed: {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uris: [process.env.GOOGLE_REDIRECT_URI || "http://localhost"],
      },
    };
  } else if (existsSync(process.env.GOOGLE_CREDENTIALS_FILE || DEFAULT_CREDENTIALS_FILE)) {
    creds = JSON.parse(readFileSync(process.env.GOOGLE_CREDENTIALS_FILE || DEFAULT_CREDENTIALS_FILE, "utf8"));
  }

  const app = creds?.installed ?? creds?.web;
  if (!app?.client_id || !app?.client_secret) {
    throw new Error(
      "Google OAuth credentials not found. Create an OAuth Desktop Client in Google Cloud, then either:\n" +
      `1) save it as ${DEFAULT_CREDENTIALS_FILE}, or\n` +
      "2) export GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before starting pi."
    );
  }

  const redirectUri = process.env.GOOGLE_REDIRECT_URI || app.redirect_uris?.[0] || "http://localhost";
  return { clientId: app.client_id, clientSecret: app.client_secret, redirectUri };
}

function getOAuthClient(): OAuth2Client {
  const { clientId, clientSecret, redirectUri } = loadOAuthConfig();
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const tokenFile = process.env.GOOGLE_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  if (existsSync(tokenFile)) {
    client.setCredentials(JSON.parse(readFileSync(tokenFile, "utf8")));
  }
  return client;
}

async function requireAuth(): Promise<OAuth2Client> {
  const client = getOAuthClient();
  if (!client.credentials || (!client.credentials.access_token && !client.credentials.refresh_token)) {
    throw new Error("Google Docs is not authenticated yet. Ask to run google_docs_auth_url, open the URL, then run google_docs_auth_code with the returned code.");
  }
  return client;
}

function saveToken(client: OAuth2Client) {
  const tokenFile = process.env.GOOGLE_TOKEN_FILE || DEFAULT_TOKEN_FILE;
  ensureDir(dirname(tokenFile));
  writeFileSync(tokenFile, JSON.stringify(client.credentials, null, 2));
}

function docToPlainText(doc: any): string {
  const parts: string[] = [];
  for (const item of doc.body?.content ?? []) {
    const paragraph = item.paragraph;
    if (!paragraph) continue;
    for (const el of paragraph.elements ?? []) {
      const text = el.textRun?.content;
      if (text) parts.push(text);
    }
  }
  return parts.join("");
}

function docSpans(doc: any) {
  const spans: Array<{ startIndex?: number; endIndex?: number; text: string }> = [];
  for (const item of doc.body?.content ?? []) {
    const paragraph = item.paragraph;
    if (!paragraph) continue;
    for (const el of paragraph.elements ?? []) {
      const text = el.textRun?.content;
      if (text) spans.push({ startIndex: el.startIndex, endIndex: el.endIndex, text });
    }
  }
  return spans;
}

function endInsertIndex(doc: any): number {
  const content = doc.body?.content ?? [];
  const last = content[content.length - 1];
  return Math.max(1, (last?.endIndex ?? 2) - 1);
}

function truncate(text: string, max = 30000): string {
  return text.length > max ? text.slice(0, max) + "\n... [truncated]" : text;
}

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function driveFileTypeClause(fileType?: string): string | undefined {
  switch (fileType) {
    case "docs":
      return "mimeType = 'application/vnd.google-apps.document'";
    case "sheets":
      return "mimeType = 'application/vnd.google-apps.spreadsheet'";
    case "slides":
      return "mimeType = 'application/vnd.google-apps.presentation'";
    case "pdfs":
      return "mimeType = 'application/pdf'";
    case "folders":
      return "mimeType = 'application/vnd.google-apps.folder'";
    case "all":
    default:
      return undefined;
  }
}

function buildDriveSearchQuery(params: { query?: string; fileType?: string; includeTrashed?: boolean; folderId?: string }): string {
  const clauses: string[] = [];
  if (!params.includeTrashed) clauses.push("trashed = false");
  const typeClause = driveFileTypeClause(params.fileType ?? "docs");
  if (typeClause) clauses.push(typeClause);
  if (params.folderId) clauses.push(`'${escapeDriveQueryLiteral(params.folderId)}' in parents`);

  const terms = (params.query ?? "").trim().split(/\s+/).filter(Boolean);
  for (const term of terms) {
    const escaped = escapeDriveQueryLiteral(term);
    clauses.push(`(name contains '${escaped}' or fullText contains '${escaped}')`);
  }

  return clauses.join(" and ") || "trashed = false";
}

function driveFilesToText(files: any[] = []): string {
  if (files.length === 0) return "[no matching files returned]";
  return files.map((file, index) => {
    const name = file.name || file.id;
    const url = file.webViewLink || (file.mimeType === "application/vnd.google-apps.document" ? `https://docs.google.com/document/d/${file.id}/edit` : undefined);
    const link = url ? `[${name}](${url})` : name;
    const owner = file.owners?.[0]?.emailAddress || file.owners?.[0]?.displayName;
    const bits = [file.mimeType, file.modifiedTime ? `modified ${file.modifiedTime}` : undefined, owner ? `owner ${owner}` : undefined].filter(Boolean).join("; ");
    return `${index + 1}. ${link}\n   id: ${file.id}${bits ? `\n   ${bits}` : ""}`;
  }).join("\n");
}

function sheetValuesToText(values: any[][] = []): string {
  if (values.length === 0) return "[no values returned]";
  return values.map((row) => row.map((cell) => String(cell ?? "")).join("\t")).join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "google_docs_auth_url",
    label: "Google Docs Auth URL",
    description: "Generate a Google OAuth URL for authorizing pi to read and edit Google Docs.",
    promptSnippet: "Generate Google OAuth URL for Google Docs/Drive access",
    promptGuidelines: ["Use google_docs_auth_url when Google Docs authentication has not been completed."],
    parameters: Type.Object({}),
    async execute() {
      const client = getOAuthClient();
      const url = client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: SCOPES,
      });
      return {
        content: [{ type: "text", text: `Open this URL, approve access, then copy the code from the redirect URL and run google_docs_auth_code:\n\n${url}` }],
        details: { url, scopes: SCOPES },
      };
    },
  });

  pi.registerTool({
    name: "google_docs_auth_code",
    label: "Google Docs Auth Code",
    description: "Exchange a Google OAuth authorization code for a saved local token.",
    promptSnippet: "Finish Google Docs OAuth by saving a token from an authorization code",
    parameters: Type.Object({
      code: Type.String({ description: "Authorization code copied from the Google redirect URL" }),
    }),
    async execute(_id, params: { code: string }) {
      const client = getOAuthClient();
      const { tokens } = await client.getToken(params.code.trim());
      client.setCredentials(tokens);
      saveToken(client);
      return {
        content: [{ type: "text", text: `Google Docs authentication saved to ${process.env.GOOGLE_TOKEN_FILE || DEFAULT_TOKEN_FILE}` }],
        details: { tokenFile: process.env.GOOGLE_TOKEN_FILE || DEFAULT_TOKEN_FILE },
      };
    },
  });

  pi.registerTool({
    name: "google_docs_search",
    label: "Google Docs Search",
    description: "Search or list Google Drive files, defaulting to Google Docs, and return matching document IDs and links.",
    promptSnippet: "Search/list Google Docs by title or text in Google Drive",
    promptGuidelines: ["Use google_docs_search when the user asks to find or list Google Docs in their account, especially when they do not have a document URL or ID."],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search text to match in file title or indexed full text. Omit to list recent files." })),
      fileType: Type.Optional(Type.Union([
        Type.Literal("docs"),
        Type.Literal("sheets"),
        Type.Literal("slides"),
        Type.Literal("pdfs"),
        Type.Literal("folders"),
        Type.Literal("all"),
      ], { description: "Type of Drive files to search. Defaults to docs." })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of files to return. Defaults to 10; max 100." })),
      includeTrashed: Type.Optional(Type.Boolean({ description: "Include trashed files. Defaults to false." })),
      folderId: Type.Optional(Type.String({ description: "Optional Drive folder ID to restrict search to direct children of that folder." })),
      orderBy: Type.Optional(Type.String({ description: "Drive files.list orderBy expression. Defaults to 'modifiedTime desc'." })),
      pageToken: Type.Optional(Type.String({ description: "Optional page token for pagination." })),
    }),
    async execute(_id, params: { query?: string; fileType?: "docs" | "sheets" | "slides" | "pdfs" | "folders" | "all"; limit?: number; includeTrashed?: boolean; folderId?: string; orderBy?: string; pageToken?: string }) {
      const auth = await requireAuth();
      const drive = google.drive({ version: "v3", auth });
      const pageSize = Math.max(1, Math.min(100, Math.floor(params.limit ?? 10)));
      const q = buildDriveSearchQuery(params);
      const res = await drive.files.list({
        q,
        pageSize,
        pageToken: params.pageToken,
        orderBy: params.orderBy ?? "modifiedTime desc",
        fields: "nextPageToken, files(id,name,mimeType,webViewLink,createdTime,modifiedTime,trashed,owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress))",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const files = res.data.files ?? [];
      return {
        content: [{ type: "text", text: truncate(`# Google Drive search\n\nQuery: ${q}\n\n${driveFilesToText(files)}${res.data.nextPageToken ? `\n\nnextPageToken: ${res.data.nextPageToken}` : ""}`) }],
        details: { q, files, nextPageToken: res.data.nextPageToken },
      };
    },
  });

  pi.registerTool({
    name: "google_docs_get",
    label: "Google Docs Get",
    description: "Read a Google Doc by document ID or URL and return plain text, with optional text spans/indexes.",
    promptSnippet: "Read Google Docs content by URL or document ID",
    promptGuidelines: ["Use google_docs_get when the user asks to read, review, summarize, or edit a Google Doc."],
    parameters: Type.Object({
      documentIdOrUrl: Type.String({ description: "Google Docs URL or document ID" }),
      includeSpans: Type.Optional(Type.Boolean({ description: "Include text spans with Google Docs indexes for precise edits" })),
    }),
    async execute(_id, params: { documentIdOrUrl: string; includeSpans?: boolean }) {
      const auth = await requireAuth();
      const docs = google.docs({ version: "v1", auth });
      const documentId = extractDocumentId(params.documentIdOrUrl);
      const res = await docs.documents.get({ documentId });
      const doc = res.data;
      const text = docToPlainText(doc);
      const details: any = { documentId, title: doc.title, text };
      if (params.includeSpans) details.spans = docSpans(doc);
      return {
        content: [{ type: "text", text: truncate(`# ${doc.title || documentId}\n\n${text}`) }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "google_docs_replace_text",
    label: "Google Docs Replace Text",
    description: "Replace all matching text in a Google Doc using Google Docs batchUpdate replaceAllText.",
    promptSnippet: "Replace text in a Google Doc",
    promptGuidelines: ["Use google_docs_replace_text for simple exact text replacements in Google Docs; confirm with the user before large/destructive replacements."],
    parameters: Type.Object({
      documentIdOrUrl: Type.String(),
      searchText: Type.String({ description: "Exact text to find" }),
      replaceText: Type.String({ description: "Replacement text" }),
      matchCase: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params: { documentIdOrUrl: string; searchText: string; replaceText: string; matchCase?: boolean }) {
      const auth = await requireAuth();
      const docs = google.docs({ version: "v1", auth });
      const documentId = extractDocumentId(params.documentIdOrUrl);
      const res = await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [{
            replaceAllText: {
              containsText: { text: params.searchText, matchCase: params.matchCase ?? true },
              replaceText: params.replaceText,
            },
          }],
        },
      });
      return {
        content: [{ type: "text", text: `Replacement complete in document ${documentId}.` }],
        details: res.data,
      };
    },
  });

  pi.registerTool({
    name: "google_docs_insert_text",
    label: "Google Docs Insert Text",
    description: "Insert text into a Google Doc at an index, or append at the end.",
    promptSnippet: "Insert or append text in a Google Doc",
    promptGuidelines: ["Use google_docs_insert_text to append or insert drafted content into a Google Doc after confirming the target location."],
    parameters: Type.Object({
      documentIdOrUrl: Type.String(),
      text: Type.String({ description: "Text to insert" }),
      index: Type.Optional(Type.Number({ description: "Google Docs insertion index. If omitted, append near the end." })),
    }),
    async execute(_id, params: { documentIdOrUrl: string; text: string; index?: number }) {
      const auth = await requireAuth();
      const docs = google.docs({ version: "v1", auth });
      const documentId = extractDocumentId(params.documentIdOrUrl);
      let index = params.index;
      if (!index) {
        const res = await docs.documents.get({ documentId });
        index = endInsertIndex(res.data);
      }
      const res = await docs.documents.batchUpdate({
        documentId,
        requestBody: { requests: [{ insertText: { location: { index }, text: params.text } }] },
      });
      return {
        content: [{ type: "text", text: `Inserted ${params.text.length} characters into document ${documentId} at index ${index}.` }],
        details: res.data,
      };
    },
  });

  pi.registerTool({
    name: "google_docs_export",
    label: "Google Docs Export",
    description: "Export a Google Doc through Google Drive as plain text or HTML.",
    promptSnippet: "Export a Google Doc as text or HTML",
    parameters: Type.Object({
      documentIdOrUrl: Type.String(),
      format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("html")], { description: "Export format" })),
    }),
    async execute(_id, params: { documentIdOrUrl: string; format?: "text" | "html" }) {
      const auth = await requireAuth();
      const drive = google.drive({ version: "v3", auth });
      const fileId = extractDocumentId(params.documentIdOrUrl);
      const mimeType = params.format === "html" ? "text/html" : "text/plain";
      const res = await drive.files.export({ fileId, mimeType }, { responseType: "text" });
      const data = String(res.data ?? "");
      return {
        content: [{ type: "text", text: truncate(data) }],
        details: { fileId, mimeType, data },
      };
    },
  });

  pi.registerTool({
    name: "google_sheets_get",
    label: "Google Sheets Get",
    description: "Read values from a Google Sheet range by spreadsheet ID or URL.",
    promptSnippet: "Read Google Sheets values by spreadsheet URL/ID and A1 range",
    promptGuidelines: ["Use google_sheets_get when the user asks to read, inspect, summarize, or analyze a Google Sheet."],
    parameters: Type.Object({
      spreadsheetIdOrUrl: Type.String({ description: "Google Sheets URL or spreadsheet ID" }),
      range: Type.String({ description: "A1 notation range, e.g. Sheet1!A1:D20" }),
    }),
    async execute(_id, params: { spreadsheetIdOrUrl: string; range: string }) {
      const auth = await requireAuth();
      const sheets = google.sheets({ version: "v4", auth });
      const spreadsheetId = extractSpreadsheetId(params.spreadsheetIdOrUrl);
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: params.range });
      const values = res.data.values ?? [];
      return {
        content: [{ type: "text", text: truncate(`# ${spreadsheetId} ${params.range}\n\n${sheetValuesToText(values)}`) }],
        details: { spreadsheetId, range: params.range, majorDimension: res.data.majorDimension, values },
      };
    },
  });

  pi.registerTool({
    name: "google_sheets_update",
    label: "Google Sheets Update",
    description: "Replace values in a Google Sheet range using spreadsheets.values.update.",
    promptSnippet: "Update Google Sheets values in an A1 range",
    promptGuidelines: ["Use google_sheets_update to modify existing Google Sheet cells; confirm with the user before destructive or broad updates."],
    parameters: Type.Object({
      spreadsheetIdOrUrl: Type.String({ description: "Google Sheets URL or spreadsheet ID" }),
      range: Type.String({ description: "A1 notation range to update, e.g. Sheet1!A1:D2" }),
      values: Type.Array(Type.Array(Type.Any()), { description: "Rows of cell values to write" }),
      valueInputOption: Type.Optional(Type.Union([Type.Literal("RAW"), Type.Literal("USER_ENTERED")], { description: "How values are interpreted. Defaults to USER_ENTERED." })),
    }),
    async execute(_id, params: { spreadsheetIdOrUrl: string; range: string; values: any[][]; valueInputOption?: "RAW" | "USER_ENTERED" }) {
      const auth = await requireAuth();
      const sheets = google.sheets({ version: "v4", auth });
      const spreadsheetId = extractSpreadsheetId(params.spreadsheetIdOrUrl);
      const res = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: params.range,
        valueInputOption: params.valueInputOption ?? "USER_ENTERED",
        requestBody: { values: params.values },
      });
      return {
        content: [{ type: "text", text: `Updated ${res.data.updatedCells ?? 0} cells in ${spreadsheetId} range ${params.range}.` }],
        details: res.data,
      };
    },
  });

  pi.registerTool({
    name: "google_sheets_append",
    label: "Google Sheets Append",
    description: "Append rows to a Google Sheet range using spreadsheets.values.append.",
    promptSnippet: "Append rows to a Google Sheet",
    promptGuidelines: ["Use google_sheets_append when the user asks to add rows to a Google Sheet; confirm the destination sheet/range first."],
    parameters: Type.Object({
      spreadsheetIdOrUrl: Type.String({ description: "Google Sheets URL or spreadsheet ID" }),
      range: Type.String({ description: "A1 notation table/range to append to, e.g. Sheet1!A:D" }),
      values: Type.Array(Type.Array(Type.Any()), { description: "Rows of cell values to append" }),
      valueInputOption: Type.Optional(Type.Union([Type.Literal("RAW"), Type.Literal("USER_ENTERED")], { description: "How values are interpreted. Defaults to USER_ENTERED." })),
      insertDataOption: Type.Optional(Type.Union([Type.Literal("INSERT_ROWS"), Type.Literal("OVERWRITE")], { description: "How new data is inserted. Defaults to INSERT_ROWS." })),
    }),
    async execute(_id, params: { spreadsheetIdOrUrl: string; range: string; values: any[][]; valueInputOption?: "RAW" | "USER_ENTERED"; insertDataOption?: "INSERT_ROWS" | "OVERWRITE" }) {
      const auth = await requireAuth();
      const sheets = google.sheets({ version: "v4", auth });
      const spreadsheetId = extractSpreadsheetId(params.spreadsheetIdOrUrl);
      const res = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: params.range,
        valueInputOption: params.valueInputOption ?? "USER_ENTERED",
        insertDataOption: params.insertDataOption ?? "INSERT_ROWS",
        requestBody: { values: params.values },
      });
      return {
        content: [{ type: "text", text: `Appended ${params.values.length} rows to ${spreadsheetId} range ${params.range}.` }],
        details: res.data,
      };
    },
  });

  pi.registerCommand("google-docs-help", {
    description: "Show setup steps for the Google Docs/Sheets pi extension",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Google Docs/Sheets extension loaded. Setup:\n1. Create Google Cloud OAuth Desktop credentials.\n2. Save JSON to ${DEFAULT_CREDENTIALS_FILE} or export GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.\n3. Ask pi to run google_docs_auth_url, then google_docs_auth_code. If you authenticated before Sheets/search support was added, re-run OAuth to grant the new Sheets/Drive metadata scopes.\n4. Use google_docs_search to find docs when you do not have a URL or ID.`,
        "info"
      );
    },
  });
}
