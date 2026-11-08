#!/usr/bin/env bash
# Pins the Kagi CLI release this action installs.
#
# Usage: scripts/pin-cli.sh <version>      for example: scripts/pin-cli.sh 0.32.0
#
# Fetches kagi-cli_<version>_checksums.txt from that release and downloads every archive the action
# can install (Linux and macOS, amd64 and arm64). Each archive must hash to the SHA-256 that the
# checksums file lists AND to the digest GitHub records for that asset (assets[].digest of the
# releases API); the checksums file must match its own recorded digest too. Any disagreement, or a
# missing digest, refuses the pin. Only then is src/cli-release.json written. Review the diff and
# commit it: the action trusts exactly the hashes in that file and nothing it downloads at run time.
#
# Needs curl and the GitHub CLI (gh), signed in, for the releases API.
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

if ! command -v gh >/dev/null 2>&1; then
  echo "error: scripts/pin-cli.sh needs the GitHub CLI (gh) to read the release's asset digests" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
release_repo="korurlabs/kagi-cli"
base_url="https://github.com/${release_repo}/releases/download/v${version}"
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

# One "name<TAB>digest" line per asset; the digest is empty when GitHub has none for that asset.
echo "Reading asset digests from repos/${release_repo}/releases/tags/v${version}"
gh api "repos/${release_repo}/releases/tags/v${version}" \
  --jq '.assets[] | [.name, (.digest // "")] | @tsv' > "$work/digests.tsv"

# Prints the hex SHA-256 GitHub records for asset $1, or fails when it has none in that form.
recorded_sha256() {
  local digest
  digest="$(awk -F '\t' -v name="$1" '$1 == name { print $2 }' "$work/digests.tsv")"
  if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "error: the GitHub API records no sha256 digest for $1 (got '${digest}'), so it cannot be cross-checked" >&2
    return 1
  fi
  echo "${digest#sha256:}"
}

checksums="kagi-cli_${version}_checksums.txt"
echo "Fetching ${base_url}/${checksums}"
curl -sSfL --retry 3 -o "$work/$checksums" "${base_url}/${checksums}"
checksums_recorded="$(recorded_sha256 "$checksums")"
checksums_actual="$(sha256_of "$work/$checksums")"
if [ "$checksums_actual" != "$checksums_recorded" ]; then
  echo "error: ${checksums} hashes to ${checksums_actual}, but GitHub records ${checksums_recorded}" >&2
  exit 1
fi

entries=()
for platform in "${platforms[@]}"; do
  asset="kagi-cli_${version}_${platform}.tar.gz"
  listed="$(awk -v name="$asset" '$2 == name { print $1 }' "$work/$checksums")"
  if [[ ! "$listed" =~ ^[0-9a-f]{64}$ ]]; then
    echo "error: ${checksums} does not list exactly one SHA-256 for ${asset}" >&2
    exit 1
  fi
  recorded="$(recorded_sha256 "$asset")"
  if [ "$recorded" != "$listed" ]; then
    echo "error: ${checksums} lists ${listed} for ${asset}, but GitHub records ${recorded}" >&2
    exit 1
  fi
  echo "Verifying ${asset}"
  curl -sSfL --retry 3 -o "$work/$asset" "${base_url}/${asset}"
  actual="$(sha256_of "$work/$asset")"
  if [ "$actual" != "$listed" ]; then
    echo "error: ${asset} hashes to ${actual}, but ${checksums} and GitHub list ${listed}" >&2
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
