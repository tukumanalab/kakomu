#!/usr/bin/env bash
# リリースに合わせて PKGBUILD のバージョンと sha256 を書き換える。
#
#   ./packaging/aur/update.sh 0.1.0
#
# .SRCINFO の生成には makepkg が要るので、Arch 上で実行してください。
# それ以外の環境では PKGBUILD の更新までを行います。
set -euo pipefail

ver="${1:-}"
if [[ -z "$ver" ]]; then
  echo "使い方: $0 <バージョン>   例: $0 0.1.0" >&2
  exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
repo="https://github.com/tukumanalab/kakomu"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch_sha() {
  local url="$1" out="$tmp/f"
  echo "取得中: $url" >&2
  if ! curl -fsSL -o "$out" "$url"; then
    echo "取得できませんでした: $url" >&2
    echo "リリースがまだ出ていないか、ファイル名が違う可能性があります。" >&2
    return 1
  fi
  if command -v sha256sum >/dev/null; then
    sha256sum "$out" | cut -d' ' -f1
  else
    shasum -a 256 "$out" | cut -d' ' -f1
  fi
}

set_field() {
  local file="$1" key="$2" value="$3"
  # sed の -i は GNU と BSD で書式が違うので、一時ファイル経由にする
  awk -v k="$key" -v v="$value" '
    $0 ~ "^" k "=" { print k "=" v; next } { print }
  ' "$file" > "$file.new" && mv "$file.new" "$file"
}

# --- kakomu-bin（ビルド済み deb） --------------------------------------
bin_sha="$(fetch_sha "${repo}/releases/download/v${ver}/kakomu_${ver}_amd64.deb")"
set_field "$here/kakomu-bin/PKGBUILD" pkgver "$ver"
set_field "$here/kakomu-bin/PKGBUILD" pkgrel 1
set_field "$here/kakomu-bin/PKGBUILD" sha256sums "('$bin_sha')"
echo "kakomu-bin: $ver / $bin_sha"

# --- kakomu（ソース） ---------------------------------------------------
src_sha="$(fetch_sha "${repo}/archive/refs/tags/v${ver}.tar.gz")"
set_field "$here/kakomu/PKGBUILD" pkgver "$ver"
set_field "$here/kakomu/PKGBUILD" pkgrel 1
set_field "$here/kakomu/PKGBUILD" sha256sums "('$src_sha')"
echo "kakomu:     $ver / $src_sha"

# --- .SRCINFO -----------------------------------------------------------
if command -v makepkg >/dev/null; then
  for p in kakomu-bin kakomu; do
    (cd "$here/$p" && makepkg --printsrcinfo > .SRCINFO)
    echo "$p/.SRCINFO を更新しました"
  done
else
  echo "makepkg が無いので .SRCINFO は更新していません（Arch 上で実行してください）" >&2
fi
