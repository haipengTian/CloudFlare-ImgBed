#!/usr/bin/env bash
# 用本地裸仓库执行真正的 fetch/merge；仅模拟远端 URL 身份检查。
set -euo pipefail
SCRIPT=$(cd -- "$(dirname -- "$0")/.." && pwd)/sync-upstream.sh
[[ -f $SCRIPT ]] || { echo 'FAIL: explicit upstream synchronization is not implemented'; exit 1; }
TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT
export REAL_GIT
REAL_GIT=$(command -v git)
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.com
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.com
mkdir "$TEST_ROOT/bin"
cat > "$TEST_ROOT/bin/git" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ $* == 'remote get-url origin' ]]; then
  printf 'https://github.com/haipengTian/CloudFlare-ImgBed.git\n'
elif [[ $* == 'remote get-url upstream' ]]; then
  printf 'https://github.com/MarSeventh/CloudFlare-ImgBed.git\n'
elif [[ ${FAIL_FETCH:-} == 1 && $* == 'fetch --no-tags upstream '* ]]; then
  printf 'synthetic fetch failure\n' >&2; exit 1
else exec "$REAL_GIT" "$@"; fi
MOCK
chmod +x "$TEST_ROOT/bin/git"
export PATH="$TEST_ROOT/bin:$PATH"
git init -q -b main "$TEST_ROOT/official"
cd "$TEST_ROOT/official"
printf 'base\n' > app.txt
git add app.txt
git commit -qm base
base=$(git rev-parse HEAD)
git clone -q --bare . "$TEST_ROOT/personal.git"
printf 'official\n' > app.txt
git commit -qam official
git tag v1.2.3
official=$(git rev-parse HEAD)
git clone -q --bare . "$TEST_ROOT/official.git"
fixture() {
  local name=$1
  git clone -q "$TEST_ROOT/personal.git" "$TEST_ROOT/$name"
  cd "$TEST_ROOT/$name"
  git remote add upstream "$TEST_ROOT/official.git"
  mkdir -p tools/custom
  cp "$SCRIPT" tools/custom/sync-upstream.sh
  git add tools
  git commit -qm tooling
}
assert() { "$@" || { printf 'FAIL: %s\n' "$*" >&2; exit 1; }; }
fixture normal
printf 'custom\n' > custom.txt
git add custom.txt
git commit -qm custom
bash tools/custom/sync-upstream.sh v1.2.3 > "$TEST_ROOT/output" 2>&1 || { cat "$TEST_ROOT/output"; exit 1; }
assert test "$(cat custom.txt)" = custom
assert test "$(cat app.txt)" = official
assert git merge-base --is-ancestor "$official" HEAD
case $(git branch --show-current) in codex/sync-upstream-*) ;; *) exit 1 ;; esac
assert test "$(find docs/custom/syncs -name '*.md' | wc -l)" -eq 1
printf 'PASS: real merge preserves custom changes and records official SHA\n'

fixture fetch-failure
git switch -qc codex/work
export FAIL_FETCH=1
if bash tools/custom/sync-upstream.sh v1.2.3 > "$TEST_ROOT/output" 2>&1; then exit 1; fi
unset FAIL_FETCH
assert test "$(git branch --show-current)" = codex/work
assert test ! -d docs/custom/syncs
printf 'PASS: failed fetch preserves original branch and never uses stale refs\n'

fixture dirty
printf 'dirty\n' >> app.txt
if bash tools/custom/sync-upstream.sh v1.2.3 > "$TEST_ROOT/output" 2>&1; then exit 1; fi
assert test "$(git branch --show-current)" = main
printf 'PASS: dirty worktree rejected\n'

fixture conflict
printf 'personal conflicting change\n' > app.txt
git commit -qam conflict
if bash tools/custom/sync-upstream.sh "$official" > "$TEST_ROOT/output" 2>&1; then exit 1; fi
assert test -f "$(git rev-parse --git-path MERGE_HEAD)"
assert test "$(git diff --name-only --diff-filter=U)" = app.txt
assert grep -q 'merge 结果：conflict' docs/custom/syncs/*.md
assert git merge-base --is-ancestor "$base" HEAD
printf 'PASS: conflicts and merge context are preserved for resolution\n'
