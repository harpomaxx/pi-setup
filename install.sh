#!/usr/bin/env bash
set -euo pipefail

# Install the latest Pi coding agent and restore this Pi setup.
#
# One-liner install:
#   curl -fsSL https://raw.githubusercontent.com/harpomaxx/pi-setup/main/install.sh | bash
#
# If you already cloned the repo:
#   ./install.sh

REPO="${PI_SETUP_REPO:-harpomaxx/pi-setup}"
REF="${PI_SETUP_REF:-main}"
AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
WORK_DIR="${PI_SETUP_WORK_DIR:-$(mktemp -d)}"
KEEP_WORK_DIR="${PI_SETUP_KEEP_WORK_DIR:-0}"
PACKAGE="${PI_PACKAGE:-@mariozechner/pi-coding-agent@latest}"
# User-writable npm global prefix. Used when the current npm global prefix is not writable,
# or always when PI_CONFIGURE_NPM_PREFIX=always. Set PI_CONFIGURE_NPM_PREFIX=never to disable.
NPM_USER_PREFIX="${PI_NPM_PREFIX:-$HOME/.npm-global}"
CONFIGURE_NPM_PREFIX="${PI_CONFIGURE_NPM_PREFIX:-auto}" # auto | always | never

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

path_contains() {
  case ":${PATH}:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

append_line_once() {
  local file="$1"
  local line="$2"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  grep -Fqx "$line" "$file" 2>/dev/null || printf '\n%s\n' "$line" >>"$file"
}

configure_shell_path() {
  local bin_dir="$1"

  export PATH="${bin_dir}:${PATH}"

  # Bash login/interactive shells commonly read ~/.bashrc on Linux.
  append_line_once "$HOME/.bashrc" "# Pi/user npm global binaries"
  append_line_once "$HOME/.bashrc" "export PATH=\"${bin_dir}:\$PATH\""

  # Fish shells read ~/.config/fish/config.fish.
  append_line_once "$HOME/.config/fish/config.fish" "# Pi/user npm global binaries"
  append_line_once "$HOME/.config/fish/config.fish" "fish_add_path -g \"${bin_dir}\""

  case "${SHELL:-}" in
    */fish) log "Updated fish PATH in ~/.config/fish/config.fish" ;;
    */bash|"") log "Updated bash PATH in ~/.bashrc" ;;
    *) warn "Unknown shell '${SHELL:-unset}'. Updated both ~/.bashrc and fish config; ensure ${bin_dir} is on PATH." ;;
  esac
}

configure_npm_user_prefix() {
  [[ "${CONFIGURE_NPM_PREFIX}" == "never" ]] && return 0

  local current_prefix current_bin should_configure
  current_prefix="$(npm config get prefix)"
  current_bin="${current_prefix}/bin"
  should_configure=0

  if [[ "${CONFIGURE_NPM_PREFIX}" == "always" ]]; then
    should_configure=1
  elif [[ ! -w "${current_prefix}" ]]; then
    should_configure=1
  elif ! path_contains "${current_bin}"; then
    # Prefix is usable, but pi would not be found after npm -g install.
    configure_shell_path "${current_bin}"
  fi

  if [[ "${should_configure}" == "1" ]]; then
    log "Configuring user npm global prefix at ${NPM_USER_PREFIX}"
    mkdir -p "${NPM_USER_PREFIX}/bin"
    npm config set prefix "${NPM_USER_PREFIX}"
    configure_shell_path "${NPM_USER_PREFIX}/bin"
  fi
}

configure_agent_env() {
  local agent_env="${AGENT_DIR}/env"
  log "Configuring shell profiles to source ${agent_env}"

  # Bash
  append_line_once "$HOME/.bashrc" "# Pi agent secrets/env"
  append_line_once "$HOME/.bashrc" 'source "$HOME/.pi/agent/env" 2>/dev/null || true'

  # Zsh
  append_line_once "$HOME/.zshrc" "# Pi agent secrets/env"
  append_line_once "$HOME/.zshrc" 'source "$HOME/.pi/agent/env" 2>/dev/null || true'

  # Fish
  append_line_once "$HOME/.config/fish/config.fish" "# Pi agent secrets/env"
  append_line_once "$HOME/.config/fish/config.fish" 'test -f "$HOME/.pi/agent/env"; and source "$HOME/.pi/agent/env"'
}

install_pi() {
  ensure_npm
  configure_npm_user_prefix
  log "Installing latest Pi coding agent: ${PACKAGE}"
  npm install -g "${PACKAGE}"
  log "Pi version: $(pi --version 2>/dev/null || "${NPM_USER_PREFIX}/bin/pi" --version 2>/dev/null || echo installed)"
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

  log "Fetching setup repo ${REPO}@${REF}"

  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    gh repo clone "${REPO}" "${dest}" -- --depth 1 --branch "${REF}" >/dev/null
    echo "${dest}"
    return 0
  fi

  require_cmd git

  # Try public clone first (no auth needed)
  if git clone --depth 1 --branch "${REF}" "https://github.com/${REPO}.git" "${dest}" >/dev/null 2>&1; then
    echo "${dest}"
    return 0
  fi

  # Fall back to token-based clone if provided
  if [[ -n "${GH_TOKEN:-}" ]]; then
    if git clone --depth 1 --branch "${REF}" "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "${dest}" >/dev/null 2>&1; then
      echo "${dest}"
      return 0
    fi
  fi

  fail "Cannot fetch setup repo. Ensure git is available and you have network access, or set GH_TOKEN if the repo requires authentication."
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

  if [[ -f "${src}/models.json" ]]; then
    cp "${src}/models.json" "${AGENT_DIR}/models.json"
  else
    warn "models.json not found"
  fi

  if [[ -f "${src}/settings.json" ]]; then
    cp "${src}/settings.json" "${AGENT_DIR}/settings.json"
  else
    warn "settings.json not found"
  fi

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
  configure_agent_env

  cat <<'EOF'

Done.

If your models.json uses environment variables for API keys, add them to
~/.pi/agent/env (e.g., export WORKFLOWY_API_KEY='...'), then restart your
shell or run: source "$HOME/.pi/agent/env"

Start Pi with:

  pi

EOF
}

main "$@"
