#!/bin/sh
# Installs the pinned Hugo (site/.hugo-version) on Linux x86-64 or arm64 into $HUGO_BIN_DIR
# (default ~/.local/bin), after checking the download against the SHA-256 recorded in
# site/hugo-checksums.txt (taken from the release's own checksums file). Used by CI; works locally.
set -eu
here=$(cd "$(dirname "$0")/../.." && pwd)
version=$(tr -d ' \r\n' < "$here/site/.hugo-version")
case "$(uname -m)" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
file="hugo_${version}_linux-${arch}.tar.gz"
expected=$(grep "  $file\$" "$here/site/hugo-checksums.txt" | cut -d' ' -f1 || true)
if [ -z "$expected" ]; then
  echo "No checksum for $file in site/hugo-checksums.txt: add it from the release's hugo_${version}_checksums.txt." >&2
  exit 1
fi
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
curl -fsSL --proto '=https' --tlsv1.2 -o "$dir/$file" "https://github.com/gohugoio/hugo/releases/download/v${version}/${file}"
actual=$(sha256sum "$dir/$file" | cut -d' ' -f1)
if [ "$actual" != "$expected" ]; then
  echo "Checksum mismatch for $file: expected $expected, got $actual." >&2
  exit 1
fi
tar -xzf "$dir/$file" -C "$dir" hugo
bin="${HUGO_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin"
install -m 0755 "$dir/hugo" "$bin/hugo"
"$bin/hugo" version
