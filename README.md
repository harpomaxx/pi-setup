# Pi Setup

Public backup of my Pi agent setup.

Includes extensions, model setup, settings, and a bootstrap installer.

Secrets and auth files are intentionally excluded.

## One-liner install on a remote box

```bash
curl -fsSL https://raw.githubusercontent.com/harpomaxx/pi-setup/main/install.sh | bash
```

Or, if the remote box already has GitHub CLI installed:

```bash
bash -c "$(gh api repos/harpomaxx/pi-setup/contents/install.sh --jq .content | base64 -d)"
```

> If fetching from a private fork, set `GH_TOKEN` with repo read access or use `gh auth login`.

The installer will:

1. Install Node.js LTS with `nvm` if `npm` is missing
2. Configure a user-writable npm global prefix when needed, defaulting to `~/.npm-global`
3. Add that npm global `bin` directory to PATH for Bash (`~/.bashrc`) and Fish (`~/.config/fish/config.fish`)
4. Run `npm install -g @mariozechner/pi-coding-agent@latest`
5. Fetch this repo
6. Copy `extensions/*.ts` to `~/.pi/agent/extensions/`
7. Copy `models.json` and `settings.json` to `~/.pi/agent/`

Useful installer options:

```bash
PI_NPM_PREFIX="$HOME/.local/npm-global"          # choose npm global prefix
PI_CONFIGURE_NPM_PREFIX=always                   # force prefix setup
PI_CONFIGURE_NPM_PREFIX=never                    # never change npm prefix/PATH
PI_SETUP_REF=main                                # repo branch/tag
PI_SETUP_REPO=harpomaxx/pi-setup                 # repo to fetch
```

If `models.json` references environment variables, you can export them before running `./install.sh` so the placeholders are expanded during copy:

```bash
export E_INFRA_API_KEY='sk-...'
export OLLAMA_API_KEY='ollama'
./install.sh
```

A `.env.example` template is included in the repo.

If the variables were not set during install, or you prefer to keep them in a file, add them to `~/.pi/agent/env` and restart your shell:

**Bash/Zsh:**
```bash
# Create once
cat > ~/.pi/agent/env <<'EOF'
export E_INFRA_API_KEY='...'
export OLLAMA_API_KEY='ollama'
export WORKFLOWY_API_KEY='...'
export ZOTERO_API_KEY='...'
EOF
chmod 600 ~/.pi/agent/env

# Source for the current shell
source "$HOME/.pi/agent/env"

# Or just restart your terminal
pi
```

**Fish:**
```fish
# Create once
printf '%s\n' \
  "export E_INFRA_API_KEY='...'" \
  "export OLLAMA_API_KEY='ollama'" \
  "export WORKFLOWY_API_KEY='...'" \
  "export ZOTERO_API_KEY='...'" \
  > ~/.pi/agent/env
chmod 600 ~/.pi/agent/env

# Source for the current shell
source "$HOME/.pi/agent/env"

# Or just restart your terminal
pi
```

The installer automatically appends a `source` line to `~/.bashrc`, `~/.zshrc`, and `~/.config/fish/config.fish` so new shells pick it up automatically.

## Extensions

| File | Description |
|------|-------------|
| `approval-gate.ts` | Claude Code-like tool approvals (`/approval`) |
| `dev-status.ts` | Footer status showing current directory and git branch |
| `stay-in-current-directory.ts` | Sandbox file access to the pi start directory |
| `update-einfra-models.ts` | Refresh the e-infra.cz provider model list in `models.json` |
| `web-search.ts` | **Web search tool** - lets the agent search DuckDuckGo for up-to-date info |
| `workflowy.ts` | **Workflowy API** - create, read, update, complete, and list Workflowy nodes |
| `zotero.ts` | **Zotero API** - search, read, list collections, and add Zotero items |

### Workflowy

The `workflowy.ts` extension registers tools to interact with the [Workflowy REST API](https://workflowy.com/api-reference). Requires a `WORKFLOWY_API_KEY` environment variable.

**Setup:**
```bash
export WORKFLOWY_API_KEY='wf_...'
pi
```

**Tools (auto-invoked by the LLM):**

| Tool | Description |
|------|-------------|
| `workflowy_create` | Add a new node (defaults to `inbox`). Supports markdown: `**bold**`, `# h1`, `- [ ] todo`, `[date]`, etc. |
| `workflowy_get` | Retrieve a single node by ID |
| `workflowy_list` | List children under a node/target (defaults to `inbox`) |
| `workflowy_update` | Edit name, note, or layout mode of a node |
| `workflowy_complete` | Mark a node as done / not done |
| `workflowy_targets` | List available targets (e.g., `inbox`, `home`) |

**Slash commands:**
```
/workflowy              # Show connection status and targets
/workflowy-export       # Export all nodes (rate limit: 1 req/min)
```

**Examples:**
- *"Add 'buy milk' to my Workflowy inbox"* → `workflowy_create(name: "buy milk")`
- *"Mark that todo as done"* → `workflowy_complete(id: "...", complete: true)`
- *"Show my inbox"* → `workflowy_list(parent_id: "inbox")`

---

### Zotero

The `zotero.ts` extension registers tools to interact with the [Zotero Web API](https://www.zotero.org/support/dev/web_api/v3/start). Requires a `ZOTERO_API_KEY` environment variable.

**Setup:**
```bash
export ZOTERO_API_KEY='...'
pi
```

**Tools (auto-invoked by the LLM):**

| Tool | Description |
|------|-------------|
| `zotero_libraries` | List user/group libraries accessible by the API key |
| `zotero_search` | Search/query items across accessible libraries |
| `zotero_get` | Retrieve full metadata and child notes/attachments for one item |
| `zotero_collections` | List collections and collection keys |
| `zotero_add` | Add a bibliographic item, optionally from DOI/Crossref metadata |

**Examples:**
- *"What are the last 5 papers added to Zotero?"* → `zotero_search(sort: "dateAdded", direction: "desc", limit: 5)`
- *"Summarize this Zotero item"* → `zotero_get(key: "...")`
- *"Add DOI 10.xxxx/yyyy to Zotero"* → `zotero_add(doi: "10.xxxx/yyyy")`

---

### e-infra.cz Models

The `update-einfra-models.ts` extension registers `update_einfra_models`, which fetches the OpenAI-compatible `/models` endpoint for e-infra.cz and updates the provider entry in `models.json`.

**Tool usage:**
- Updates `~/.pi/agent/models.json` by default.
- Supports dry-run mode and optional inclusion of embedding/reranker models.
- Intended for requests like *"refresh/update the e-infra.cz models"*.

---

### Web Search

The `web-search.ts` extension registers a `web_search` tool that the LLM can call automatically, plus a `/websearch` slash command for manual queries.

**Tool usage:**
- The agent invokes `web_search` with a `query` and optional `max_results` (1–10, default 5).
- Results include titles, URLs, and snippets, properly truncated to Pi's 50 KB / 2000-line limit.
- No API key is required — it scrapes DuckDuckGo anonymously.

**Resilience features:**
- **Rotating User-Agents** — cycles through 6 realistic browser strings on each retry
- **Multiple endpoints** — falls back across `duckduckgo.com/html/`, `html.duckduckgo.com/html/`, and `lite.duckduckgo.com/lite/`
- **Exponential backoff + jitter** — retries up to 3 times per endpoint with delays of ~1.5s, 3s, 6s
- **CAPTCHA detection** — detects bot challenge pages and automatically retries or moves to the next endpoint
- **Clear error messages** — if all endpoints fail, reports a human-readable error with suggestions

**Manual usage:**
```
/websearch how to center a div in css
```

**Note:** If DuckDuckGo consistently blocks your IP (common on cloud/VPN hosts), consider adding a search provider with an API key (e.g., Serper, Bing) as a fallback.

## Manual restore

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/*.ts ~/.pi/agent/extensions/
cp models.json ~/.pi/agent/models.json
cp settings.json ~/.pi/agent/settings.json
```

Then restart Pi or run `/reload`.
