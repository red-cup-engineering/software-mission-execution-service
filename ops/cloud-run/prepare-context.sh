#!/usr/bin/env bash
set -euo pipefail
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$script_dir
while [[ ! -d "$repo_root/lib/emsenn/services/561-group" || ! -d "$repo_root/lib/emsenn/services/561-group/services/board-of-directors" ]]; do parent=$(dirname -- "$repo_root"); [[ "$parent" != "$repo_root" ]] || exit 66; repo_root=$parent; done
context_dir=${1:-}
[[ "$context_dir" == /tmp/* ]] || { echo "usage: $0 /tmp/build-context" >&2; exit 64; }
package=lib/emsenn/services/561-group/services/red-cup-engineering/services/software-services-section/services/software-development-services-section/services/javascript-services-section/services/software-mission-execution-service
mapfile -t packages < <(node - "$repo_root" "$package" <<'NODE'
const fs = require("node:fs"), path = require("node:path");
const root = process.argv[2], entry = path.join(root, process.argv[3]), seen = new Set();
function visit(directory) { directory = path.resolve(directory); if (seen.has(directory)) return; seen.add(directory); const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"))); for (const spec of Object.values({ ...manifest.dependencies, ...manifest.optionalDependencies })) if (typeof spec === "string" && spec.startsWith("file:")) visit(path.resolve(directory, spec.slice(5))); }
visit(entry); for (const directory of [...seen].sort()) console.log(path.relative(root, directory));
NODE
)
mkdir -p "$context_dir"
for relative in "${packages[@]}"; do mkdir -p "$context_dir/$relative"; tar --exclude='node_modules' --exclude='*/node_modules' --exclude='data' --exclude='*/data' --exclude='.git' --exclude='*/.git' --exclude='test' --exclude='*/test' --exclude='ops' --exclude='*/ops' -C "$repo_root/$relative" -cf - . | tar -C "$context_dir/$relative" -xf -; done
cp "$script_dir/Dockerfile" "$context_dir/Dockerfile"
cp "$script_dir/cloudbuild.yaml" "$context_dir/cloudbuild.yaml"
