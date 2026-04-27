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

If `models.json` references environment variables, export them before starting Pi, for example:

```bash
export E_INFRA_API_KEY='...'
pi
```

## Manual restore

```bash
mkdir -p ~/.pi/agent/extensions
cp extensions/*.ts ~/.pi/agent/extensions/
cp models.json ~/.pi/agent/models.json
cp settings.json ~/.pi/agent/settings.json
```

Then restart Pi or run `/reload`.
