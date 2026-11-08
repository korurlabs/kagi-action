#!/usr/bin/env bash
# Pins the Kagi CLI release this action installs.
#
# Usage: scripts/pin-cli.sh <version>      for example: scripts/pin-cli.sh 0.32.0
#
# Fetches kagi-cli_<version>_checksums.txt from that release, downloads every archive the action
# can install (Linux and macOS, amd64 and arm64), checks that each one hashes to the SHA-256 the
# checksums file lists, and writes src/cli-release.json. Review the diff and commit it: the action
# trusts exactly the hashes in that file and nothing it downloads at run time.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/pin-cli.sh <version>   (for example: scripts/pin-cli.sh 0.32.0)" >&2
  exit 2
fi

version="${1#v}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '$1' is not a Kagi CLI version such as 0.32.0" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
base_url="https://github.com/korurlabs/kagi-cli/releases/download/v${version}"
platforms=(darwin_amd64 darwin_arm64 linux_amd64 linux_arm64)

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

checksums="kagi-cli_${version}_checksums.txt"
echo "Fetching ${base_url}/${checksums}"
curl -sSfL --retry 3 -o "$work/$checksums" "${base_url}/${checksums}"

entries=()
for platform in "${platforms[@]}"; do
  asset="kagi-cli_${version}_${platform}.tar.gz"
  listed="$(awk -v name="$asset" '$2 == name { print $1 }' "$work/$checksums")"
  if [[ ! "$listed" =~ ^[0-9a-f]{64}$ ]]; then
    echo "error: ${checksums} does not list exactly one SHA-256 for ${asset}" >&2
    exit 1
  fi
  echo "Verifying ${asset}"
  curl -sSfL --retry 3 -o "$work/$asset" "${base_url}/${asset}"
  actual="$(sha256_of "$work/$asset")"
  if [ "$actual" != "$listed" ]; then
    echo "error: ${asset} hashes to ${actual}, but ${checksums} lists ${listed}" >&2
    exit 1
  fi
  entries+=("    \"${asset}\": \"${listed}\"")
done

{
  printf '{\n  "version": "%s",\n  "assets": {\n' "$version"
  last=$((${#entries[@]} - 1))
  for i in "${!entries[@]}"; do
    if [ "$i" -lt "$last" ]; then
      printf '%s,\n' "${entries[$i]}"
    else
      printf '%s\n' "${entries[$i]}"
    fi
  done
  printf '  }\n}\n'
} > "$work/cli-release.json"

mv "$work/cli-release.json" "$repo_root/src/cli-release.json"
echo "Pinned kagi-cli ${version} in src/cli-release.json"
