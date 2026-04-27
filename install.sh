#!/usr/bin/env bash
set -euo pipefail

# Install the latest Pi coding agent and restore this Pi setup.
#
# Private repo one-liner example:
#   GH_TOKEN=github_pat_xxx bash -c 'curl -fsSL -H "Authorization: Bearer ${GH_TOKEN}" https://raw.githubusercontent.com/harpomaxx/pi-setup/main/install.sh | bash'
#
# If you already cloned the repo:
#   ./install.sh

REPO="${PI_SETUP_REPO:-harpomaxx/pi-setup}"
REF="${PI_SETUP_REF:-main}"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
WORK_DIR="${PI_SETUP_WORK_DIR:-$(mktemp -d)}"
KEEP_WORK_DIR="${PI_SETUP_KEEP_WORK_DIR:-0}"
PACKAGE="${PI_PACKAGE:-@mariozechner/pi-coding-agent@latest}"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [[ "${KEEP_WORK_DIR}" != "1" && -n "${WORK_DIR:-}" && -d "${WORK_DIR}" && "${WORK_DIR}" == /tmp/* ]]; then
    rm -rf "${WORK_DIR}"
  fi
}
trap cleanup EXIT

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

ensure_npm() {
  if command -v npm >/dev/null 2>&1; then
    return 0
  fi

  log "npm not found; installing Node.js LTS with nvm"
  require_cmd curl
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts
}

install_pi() {
  ensure_npm
  log "Installing latest Pi coding agent: ${PACKAGE}"
  npm install -g "${PACKAGE}"
  log "Pi version: $(pi --version 2>/dev/null || echo installed)"
}

fetch_repo() {
  # If the script is executed from an already cloned checkout, use that.
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd -P || true)"
  if [[ -n "${script_dir}" && -f "${script_dir}/models.json" && -d "${script_dir}/extensions" ]]; then
    echo "${script_dir}"
    return 0
  fi

  mkdir -p "${WORK_DIR}"
  local dest="${WORK_DIR}/pi-setup"

  log "Fetching private setup repo ${REPO}@${REF}"

  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh repo clone "${REPO}" "${dest}" -- --depth 1 --branch "${REF}" >/dev/null
    echo "${dest}"
    return 0
  fi

  require_cmd git
  if [[ -n "${GH_TOKEN:-}" ]]; then
    git clone --depth 1 --branch "${REF}" "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "${dest}" >/dev/null 2>&1
    echo "${dest}"
    return 0
  fi

  fail "Cannot fetch private repo. Install/login with GitHub CLI ('gh auth login') or set GH_TOKEN with repo read access."
}

restore_setup() {
  local src="$1"
  log "Restoring Pi setup into ${AGENT_DIR}"
  mkdir -p "${AGENT_DIR}/extensions"

  if compgen -G "${src}/extensions/*.ts" >/dev/null; then
    cp "${src}"/extensions/*.ts "${AGENT_DIR}/extensions/"
  else
    warn "No extensions/*.ts found in setup repo"
  fi

  [[ -f "${src}/models.json" ]] && cp "${src}/models.json" "${AGENT_DIR}/models.json" || warn "models.json not found"
  [[ -f "${src}/settings.json" ]] && cp "${src}/settings.json" "${AGENT_DIR}/settings.json" || warn "settings.json not found"

  chmod 700 "${AGENT_DIR}" "${AGENT_DIR}/extensions" 2>/dev/null || true
  chmod 600 "${AGENT_DIR}/models.json" "${AGENT_DIR}/settings.json" 2>/dev/null || true

  log "Installed extensions:"
  ls -1 "${AGENT_DIR}/extensions"/*.ts 2>/dev/null | sed 's/^/  - /' || true
}

main() {
  install_pi
  local setup_dir
  setup_dir="$(fetch_repo)"
  restore_setup "${setup_dir}"

  cat <<'EOF'

Done.

If your models.json uses environment variables for API keys, export them before starting pi, for example:

  export E_INFRA_API_KEY='...'

Start Pi with:

  pi

EOF
}

main "$@"
