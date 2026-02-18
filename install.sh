#!/usr/bin/env sh

set -eu

REPO="sudhirj/darkhold"
VERSION="latest"
INSTALL_DIR=""
VARIANT="default"
FORCE_MUSL="auto"

usage() {
  cat <<USAGE
Usage: $0 [options]

Install darkhold from GitHub releases.

Options:
  --version <tag|latest>   Release tag to install (default: latest)
  --repo <owner/repo>      GitHub repository (default: sudhirj/darkhold)
  --install-dir <dir>      Install directory (default: /usr/local/bin or ~/.local/bin)
  --variant <default|baseline|modern>
                           CPU variant for x64 builds (default: default)
  --musl <auto|true|false> Linux libc selection (default: auto)
  -h, --help               Show this help

Examples:
  $0
  $0 --version v0.1.0
  $0 --version build-abcdef123456 --install-dir "$HOME/.local/bin"
USAGE
}

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version)
        [ "$#" -ge 2 ] || fail "--version requires a value"
        VERSION="$2"
        shift 2
        ;;
      --repo)
        [ "$#" -ge 2 ] || fail "--repo requires a value"
        REPO="$2"
        shift 2
        ;;
      --install-dir)
        [ "$#" -ge 2 ] || fail "--install-dir requires a value"
        INSTALL_DIR="$2"
        shift 2
        ;;
      --variant)
        [ "$#" -ge 2 ] || fail "--variant requires a value"
        VARIANT="$2"
        shift 2
        ;;
      --musl)
        [ "$#" -ge 2 ] || fail "--musl requires a value"
        FORCE_MUSL="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown argument: $1"
        ;;
    esac
  done

  case "$VARIANT" in
    default|baseline|modern) ;;
    *) fail "--variant must be one of: default, baseline, modern" ;;
  esac

  case "$FORCE_MUSL" in
    auto|true|false) ;;
    *) fail "--musl must be one of: auto, true, false" ;;
  esac
}

is_linux_musl() {
  if [ "$FORCE_MUSL" = "true" ]; then
    return 0
  fi
  if [ "$FORCE_MUSL" = "false" ]; then
    return 1
  fi

  if command -v ldd >/dev/null 2>&1; then
    if ldd --version 2>&1 | grep -qi musl; then
      return 0
    fi
  fi

  if [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then
    return 0
  fi

  return 1
}

asset_suffix() {
  if [ "$VARIANT" = "default" ]; then
    printf '%s' ""
  else
    printf '%s' "-$VARIANT"
  fi
}

compute_asset_name() {
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  suffix="$(asset_suffix)"

  case "$os" in
    linux)
      case "$arch" in
        x86_64|amd64)
          if is_linux_musl; then
            printf '%s' "darkhold-bun-linux-x64-musl$suffix"
          else
            printf '%s' "darkhold-bun-linux-x64$suffix"
          fi
          ;;
        aarch64|arm64)
          if [ "$VARIANT" != "default" ]; then
            fail "--variant is only supported for x64 targets"
          fi
          if is_linux_musl; then
            printf '%s' "darkhold-bun-linux-arm64-musl"
          else
            printf '%s' "darkhold-bun-linux-arm64"
          fi
          ;;
        *) fail "Unsupported Linux architecture: $arch" ;;
      esac
      ;;
    darwin)
      case "$arch" in
        x86_64|amd64)
          printf '%s' "darkhold-bun-darwin-x64$suffix"
          ;;
        arm64)
          if [ "$VARIANT" != "default" ]; then
            fail "--variant is only supported for x64 targets"
          fi
          printf '%s' "darkhold-bun-darwin-arm64"
          ;;
        *) fail "Unsupported macOS architecture: $arch" ;;
      esac
      ;;
    msys*|mingw*|cygwin*)
      case "$arch" in
        x86_64|amd64)
          printf '%s' "darkhold-bun-windows-x64$suffix.exe"
          ;;
        *) fail "Unsupported Windows architecture: $arch" ;;
      esac
      ;;
    *) fail "Unsupported OS: $os" ;;
  esac
}

resolve_install_dir() {
  if [ -n "$INSTALL_DIR" ]; then
    printf '%s' "$INSTALL_DIR"
    return
  fi

  if [ -w /usr/local/bin ] || [ ! -e /usr/local/bin ] && [ -w /usr/local ]; then
    printf '%s' "/usr/local/bin"
  else
    printf '%s' "$HOME/.local/bin"
  fi
}

build_download_url() {
  asset="$1"
  if [ "$VERSION" = "latest" ]; then
    printf '%s' "https://github.com/$REPO/releases/latest/download/$asset"
  else
    printf '%s' "https://github.com/$REPO/releases/download/$VERSION/$asset"
  fi
}

install_binary() {
  require_cmd curl
  require_cmd mktemp

  asset_name="$(compute_asset_name)"
  target_dir="$(resolve_install_dir)"
  url="$(build_download_url "$asset_name")"

  mkdir -p "$target_dir"

  tmp_file="$(mktemp "${TMPDIR:-/tmp}/darkhold.XXXXXX")"
  trap 'rm -f "$tmp_file"' EXIT INT TERM

  log "Downloading $asset_name from $REPO ($VERSION)..."
  if ! curl -fL --retry 3 --connect-timeout 10 "$url" -o "$tmp_file"; then
    fail "Failed to download release asset: $url"
  fi

  bin_name="darkhold"
  case "$asset_name" in
    *.exe) bin_name="darkhold.exe" ;;
  esac

  install_path="$target_dir/$bin_name"
  mv "$tmp_file" "$install_path"
  chmod +x "$install_path"

  log "Installed to $install_path"
  if command -v "$bin_name" >/dev/null 2>&1; then
    log "Run: $bin_name --help"
  else
    log "Add $target_dir to PATH to run '$bin_name' directly."
  fi
}

parse_args "$@"
install_binary
