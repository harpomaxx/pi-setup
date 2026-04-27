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

If `models.json` references environment variables, add them to `~/.pi/agent/env` and restart your shell:

**Bash/Zsh:**
```bash
# Create once
cat > ~/.pi/agent/env <<'EOF'
export E_INFRA_API_KEY='...'
export WORKFLOWY_API_KEY='...'
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
  "export WORKFLOWY_API_KEY='...'" \
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
| `stay-in-current-directory.ts` | Sandbox file access to the pi start directory |
| `web-search.ts` | **Web search tool** — lets the agent search DuckDuckGo for up-to-date info |
| `workflowy.ts` | **Workflowy API** — create, read, update, complete, and list Workflowy nodes |

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

### Web Search

The `web-search.ts` extension registers a `web_search` tool that the LLM can call automatically, plus a `/websearch` slash command for manual queries.

**Tool usage:**
- The agent invokes `web_search` with a `query` and optional `max_results` (1–10, default 5).
- Results include titles, URLs, and snippets, properly truncated to Pi’s 50 KB / 2000-line limit.
- No API key is required — it scrapes DuckDuckGo anonymously.

**Manual usage:**
```
/websearch how to center a div in css
```

**Note:** DuckDuckGo may occasionally block automated requests. If searches start failing consistently, consider switching to a search provider with an API key (e.g., Serper, Bing).

## Manual restore

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/*.ts ~/.pi/agent/extensions/
cp models.json ~/.pi/agent/models.json
cp settings.json ~/.pi/agent/settings.json
```

Then restart Pi or run `/reload`.
