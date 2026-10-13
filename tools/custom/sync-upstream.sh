#!/usr/bin/env bash
# 从个人 main 创建融合分支；只接受明确的官方 tag/commit，不使用过期的远程引用。
set -euo pipefail
die() { printf '错误：%s\n' "$*" >&2; exit 1; }
[[ $# == 1 ]] || die '用法：bash tools/custom/sync-upstream.sh <官方 v版本标签或完整提交 SHA>'
target=$1
[[ $target =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ || $target =~ ^[a-f0-9]{40}$ ]] ||
  die '请指定官方版本标签或 40 位提交 SHA'
root=$(git rev-parse --show-toplevel)
cd "$root"
[[ -z $(git status --porcelain) ]] || die '先保存当前改动并提交，工作区必须干净'
[[ ! -e $(git rev-parse --git-path MERGE_HEAD) ]] || die '先完成或取消当前 merge'
[[ $(git remote get-url origin) == https://github.com/haipengTian/CloudFlare-ImgBed.git ||
   $(git remote get-url origin) == git@github.com:haipengTian/CloudFlare-ImgBed.git ]] || die 'origin 不是预期的个人仓库'
[[ $(git remote get-url upstream) == https://github.com/MarSeventh/CloudFlare-ImgBed.git ||
   $(git remote get-url upstream) == git@github.com:MarSeventh/CloudFlare-ImgBed.git ]] || die 'upstream 不是预期的官方仓库'
git show-ref --verify --quiet refs/heads/main || die '缺少本地 main 分支'
# 两次 fetch 均完成后才改变本地分支，失败时不会融合缓存中的旧代码。
git fetch --no-tags origin main
personal=$(git rev-parse 'FETCH_HEAD^{commit}')
git fetch --no-tags upstream "$target"
official=$(git rev-parse 'FETCH_HEAD^{commit}')
[[ ! $target =~ ^[a-f0-9]{40}$ || $official == "$target" ]] || die '获取的官方 SHA 与请求不一致'
git switch main
git merge --ff-only "$personal" || die '个人 main 与远端已分叉，请先检查双方提交，不要强制重置'
baseline=$(git rev-parse HEAD)
branch="codex/sync-upstream-$(date -u +%Y%m%dT%H%M%SZ)-${official:0:12}"
git switch -c "$branch"
result=merged
if ! git merge --no-ff --no-edit "$official"; then result=conflict; fi
record="docs/custom/syncs/$(date -u +%Y%m%dT%H%M%SZ)-${official:0:12}.md"
mkdir -p docs/custom/syncs
cat > "$record" <<EOF
# 官方融合记录

- 官方来源：https://github.com/MarSeventh/CloudFlare-ImgBed
- 官方目标：$target
- 官方 SHA：$official
- 获取到的个人远端 SHA：$personal
- 个人融合基线：$baseline
- 融合分支：$branch
- merge 结果：$result
- 验证：待完成。此记录不代表可发布或已部署。

请补充冲突处理、迁移兼容性、二开回归结果和个人发布版本，然后提交此记录。
EOF
if [[ $result == conflict ]]; then
  printf '融合未完成，已保留冲突现场和记录：%s\n解决后 git add / git merge --continue；取消用 git merge --abort。\n' "$record" >&2
  exit 1
fi
printf '已创建融合分支 %s，官方 SHA %s。\n记录：%s\n请运行 docs/custom/README.md 中的检查，再合入个人 main。\n' "$branch" "$official" "$record"
