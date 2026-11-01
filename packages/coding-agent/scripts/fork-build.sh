#!/usr/bin/env bash
# Build this fork; optionally merge upstream before verification and installation.
set -euo pipefail

usage() {
	cat <<'HELP'
Usage: fork-build.sh [--update] [--install-dir DIR] [--build-only]

  --update           Fetch and merge upstream/main first; requires a clean branch.
  --install-dir DIR  Install omp in DIR (default: ~/.local/bin).
  --build-only       Verify and build without replacing an installed executable.

BUN may name a Bun executable. Existing HTTPS_PROXY/HTTP_PROXY and Git credentials
are used normally. No GitHub token is stored, and this command never pushes.
HELP
}

update=0
build_only=0
install_dir=${HOME}/.local/bin
while (($#)); do
	case "$1" in
		--update) update=1 ;;
		--build-only) build_only=1 ;;
		--install-dir)
			[[ $# -ge 2 && -n $2 ]] || { usage >&2; exit 2; }
			install_dir=$2
			shift
			;;
		-h|--help) usage; exit 0 ;;
		*) printf 'Unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
	esac
	shift
done

repo=$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
cd "$repo"
bun=$(command -v "${BUN:-bun}") || { printf 'Install Bun >=1.4.4 or set BUN.\n' >&2; exit 1; }
export PATH="$(dirname -- "$bun"):$repo/node_modules/.bin:$PATH"
# Reuse a repository-local Git proxy for Bun downloads unless the caller supplied one.
proxy=$(git config --get http.proxy || true)
if [[ -n $proxy ]]; then
	export HTTPS_PROXY=${HTTPS_PROXY:-${https_proxy:-$proxy}}
	export HTTP_PROXY=${HTTP_PROXY:-${http_proxy:-$proxy}}
fi
command -v flock >/dev/null || { printf 'This Linux build helper requires flock.\n' >&2; exit 1; }
exec 9>"$(git rev-parse --git-path fork-build.lock)"
flock -n 9 || { printf 'Another fork build is running.\n' >&2; exit 1; }

generated=packages/catalog/src/compat/rules.json
finish_merge=0
if ((update)); then
	git symbolic-ref --quiet HEAD >/dev/null || { printf 'Check out your maintained branch first.\n' >&2; exit 1; }
	[[ -z $(git status --porcelain --untracked-files=normal) ]] || {
		printf 'Commit or stash local edits before --update. Installation is unchanged.\n' >&2
		exit 1
	}
	git fetch upstream main
	if ! git merge --no-edit FETCH_HEAD; then
		conflicts=$(git diff --name-only --diff-filter=U)
		if [[ $conflicts != "$generated" ]]; then
			printf 'Resolve source conflicts, commit the merge, then run this helper without --update. Installation is unchanged.\n' >&2
			exit 1
		fi
		finish_merge=1
	fi
fi
conflicts=$(git diff --name-only --diff-filter=U)
if [[ -n $conflicts && $conflicts != "$generated" ]]; then
	printf 'Unresolved source conflicts prevent a build. Installation is unchanged.\n' >&2
	exit 1
fi
if [[ $conflicts == "$generated" ]]; then finish_merge=1; fi

native_tmp=
staged=
cleanup() {
	[[ -z $native_tmp ]] || rm -rf -- "$native_tmp"
	[[ -z $staged ]] || rm -f -- "$staged"
}
trap cleanup EXIT

"$bun" install --frozen-lockfile --ignore-scripts --network-concurrency 4
version=$("$bun" -p 'JSON.parse(await Bun.file("packages/natives/package.json").text()).version')
platform=$("$bun" -p 'process.platform')
arch=$("$bun" -p 'process.arch')
# Fetch the exact published native version, rather than reusing an older addon.
# Bun checks package integrity; the compiler also checks the embedded version stamp.
native_tmp=$(mktemp -d)
printf '{"private":true}\n' > "$native_tmp/package.json"
"$bun" add --cwd "$native_tmp" --ignore-scripts "@oh-my-pi/pi-natives-${platform}-${arch}@${version}"
leaf="$native_tmp/node_modules/@oh-my-pi/pi-natives-${platform}-${arch}"
shopt -s nullglob
addons=("$leaf"/pi_natives.*.node)
((${#addons[@]})) || { printf 'Published package contains no native addon.\n' >&2; exit 1; }
for addon in "${addons[@]}"; do
	destination="$repo/packages/natives/native/$(basename -- "$addon")"
	# Replace the directory entry, not the target of an old developer symlink.
	install -m 644 -- "$addon" "${destination}.fork-new"
	mv -f -- "${destination}.fork-new" "$destination"
done

"$bun" run --cwd packages/catalog gen:compat
"$bun" test \
	packages/ai/test/google-antigravity-usage.test.ts \
	packages/ai/test/auth-storage-antigravity-selection.test.ts \
	packages/catalog/test/compat-compile.test.ts \
	packages/ai/test/auth-storage-codex-selection.test.ts \
	packages/ai/test/auth-storage-block-persistence.test.ts \
	packages/ai/test/auth-storage-model-usage-health.test.ts \
	packages/ai/test/auth-storage-usage-cache.test.ts \
	packages/ai/test/credential-external-reload.test.ts \
	packages/ai/test/rate-limit-utils.test.ts \
	packages/ai/test/auth-storage-oauth-account-select.test.ts \
	packages/ai/test/auth-storage-session-restriction.test.ts \
	packages/ai/test/auth-storage-force-refresh-rotate.test.ts
"$bun" run --cwd packages/ai check:types
"$bun" run --cwd packages/catalog check:types
if ((finish_merge)); then
	git add -- "$generated"
	git commit --no-edit
fi
CROSS_TARGET= "$bun" packages/coding-agent/scripts/build-binary.ts
candidate="$repo/packages/coding-agent/dist/omp"
"$candidate" --version
"$candidate" --smoke-test
if ((build_only)); then
	printf 'Verified fork build: %s\n' "$candidate"
	exit 0
fi

mkdir -p -- "$install_dir"
install_dir=$(cd "$install_dir" && pwd -P)
target="$install_dir/omp"
[[ ! -L $target ]] || { printf 'Refusing to replace a symlink-managed install: %s\n' "$target" >&2; exit 1; }
state="${XDG_STATE_HOME:-$HOME/.local/state}/omp/fork-builds"
mkdir -p -- "$state"
backup_dir=$(mktemp -d "$state/build-XXXXXXXX")
chmod 700 "$backup_dir"
if [[ -e $target ]]; then cp -p -- "$target" "$backup_dir/omp.before"; fi
staged=$(mktemp "$install_dir/.omp-fork-XXXXXXXX")
install -m 755 -- "$candidate" "$staged"
"$staged" --smoke-test
if [[ -e $backup_dir/omp.before ]]; then
	cmp -s -- "$target" "$backup_dir/omp.before" || { printf 'Install changed concurrently; refusing replacement.\n' >&2; exit 1; }
elif [[ -e $target ]]; then
	printf 'Install appeared concurrently; refusing replacement.\n' >&2
	exit 1
fi
mv -f -- "$staged" "$target"
staged=
if ! "$target" --smoke-test; then
	if [[ -e $backup_dir/omp.before ]]; then
		staged=$(mktemp "$install_dir/.omp-fork-XXXXXXXX")
		cp -p -- "$backup_dir/omp.before" "$staged"
		mv -f -- "$staged" "$target"
		staged=
	else
		rm -f -- "$target"
	fi
	printf 'Installed smoke failed; previous executable restored when available.\n' >&2
	exit 1
fi
printf 'source=%s\ncommit=%s\nversion=%s\n' "$repo" "$(git rev-parse HEAD)" "$version" > "$backup_dir/build-info.txt"
sha256sum -- "$target" >> "$backup_dir/build-info.txt"
printf 'Installed %s\nRollback and build record: %s\nRunning sessions were not restarted.\n' "$target" "$backup_dir"
