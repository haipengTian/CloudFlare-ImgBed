# 个人部署、上游融合与二开

个人仓库：`https://github.com/haipengTian/CloudFlare-ImgBed`；官方：`https://github.com/MarSeventh/CloudFlare-ImgBed`。
部署配置在 `haipengTian/server-ops/imgbed/`，域名为 `img.thpvip.xyz`。
产品仓库维护代码、检查与镜像；运维仓库维护服务器安装、HTTPS、备份和升级。
本次仅准备部署与维护基础，没有新增业务二开功能。

## 当前基线与分支

2026-10-13 实际 fetch 核实：个人 origin/main、官方 upstream/main 均为
`0d219dd45f514265ba9cb17788059fd7a1b1240d`，package.json 版本 `2.7.7`。
本次维护分支 `codex/imgbed-self-hosting` 从该个人远端基线创建；原本地 main 留在
`07fe2501b4ba0e3c6bc59c6317405413cef356e8`，未重置、未合并 main。
该维护分支含从旧 main 到当前基线的112个上游提交，合入时应核对范围。
官方已配置为 upstream。本次未推送、未创建 tag、未发布镜像、未部署服务器。

## 上游同步

本维护分支中的原定时主分支同步和 Worker 自动部署会跳过个人仓库，合入并推送后生效。
原 workflow 在其他 Fork 的行为保留，个人仓库 guard 是二开维护的重要改动，后续融合要保留。

提交并审查本次维护分支、合入个人 main 后，在干净工作区选择明确的官方 tag 或完整提交 SHA：

```bash
git remote -v
# upstream 未配置才需要：
# git remote add upstream https://github.com/MarSeventh/CloudFlare-ImgBed.git
git ls-remote --tags upstream
bash tools/custom/sync-upstream.sh 0d219dd45f514265ba9cb17788059fd7a1b1240d
```

每次替换为实际核实的目标。脚本在个人及官方 fetch 都成功后，才允许个人 main 快进；
分叉时停止，不强制重置。随后创建 `codex/sync-upstream-时间-SHA`，merge 官方目标并记录到
`docs/custom/syncs/`。有冲突会保留 MERGE_HEAD 与记录；解决后 `git add`、`git merge --continue`。
取消用 `git merge --abort`，记录保留。不会自动推送、发布、操作服务器或发 Issue。

官方稳定 tag 不一定总是匹配当前 main，需检查对应版本和迁移。
读取上游 `.github/breaking-updates/` 的公告、版本更新和 SQL 迁移，补充合并记录的兼容性与回归结果。

## 检查

维护工具测试执行实际本地 Git fetch/merge，无需网络与 Docker：

```bash
bash -n tools/custom/sync-upstream.sh
bash tools/custom/tests/sync-upstream.sh
node --check tools/custom/tests/smoke.mjs
```

Docker 使用 Node22 和现有多阶段 Dockerfile，按 upstream 的 server/common workspace 锁文件安装。
前端源码属于独立项目 `MarSeventh/Sanyue-ImgHub`，本仓库是 `frontend-dist` 产物；以后修改 UI，
应先建立自己的前端 Fork、按其流程构建，再更新本仓库产物，避免直接修改压缩文件。
后端改动使用 functions/ 现有接口，Docker 适配在 deploy/server/，Workers 适配在 deploy/worker/。

本仓库的旧 `npm test` 指向 Mocha，但没有对应 test/ 用例；不能以该命令代替产品验收。
个人工作流运行实际 Docker smoke：匿名访问保护、错误密码、管理员登录、本地文件上传与字节比对、
容器重启后的数据保留及删除。该测试不接触真实外部 Bucket/Telegram。
就绪配置回归在已安装依赖的镜像内运行，检查持久化空密码和数据库读取失败；
Docker healthcheck 同时读取真实有效配置并验证实际管理员用户名配错误密码会被拒绝。
每次上游融合、二开增加相应回归，存储或数据库改动需要额外测试真实渠道和迁移恢复。

## 发布个人镜像

1. 将检查通过的代码及发布记录合入并推送个人 main。
2. GitHub Actions 中手动运行 **Personal Docker image**，选择源代码分支，填版本如 `v2.7.7-custom.1`。
   版本前缀必须与源码 package.json 一致。手动运行只构建和测试，不发布。
3. 验证成功后，在**同一个已推送且属于 main 的提交**创建并推送个人 tag：

   ```bash
   test -z "$(git status --porcelain)"
   source_sha=$(git rev-parse HEAD)
   git tag -a v2.7.7-custom.1 "$source_sha" -m 'ImgBed custom release'
   git push origin v2.7.7-custom.1
   ```

4. tag 自动触发工作流：验证版本及 main 归属，执行维护工具检查、构建镜像与 amd64 Docker smoke，
   全部成功后发布 `ghcr.io/haipengtian/cloudflare-imgbed:2.7.7-custom.1`，支持 amd64/arm64。
   不发布 latest；手动运行不能发布。arm64 本次仅构建，目标服务器另行验收。
5. 确认 GHCR 包可见性（首次可能私有），记录源SHA、工作流URL、镜像摘要、架构和验收结果。
   再按 server-ops/imgbed/README.md 安装或升级。

个人工作流通过 GITHUB_TOKEN 的 packages:write 发布，不需要提供额外 DockerHub Token。
GitHub Actions 需已启用且仓库策略允许 Packages 写入；本次未现场执行线上工作流。
每次个人改动增加 custom 序号；同步到新官方版本时更换版本前缀。
官方原 docker-publish 工作流仍只在官方仓库发布，避免误用官方 DockerHub 的发布配置。

## 以后做二开

每项功能从已融合且可交付的个人 main 建立 `codex/feature-名称`，先写行为测试，再实现并记录回归。
优先保留官方接口与配置结构，把功能改动按独立提交管理，避免混入无关格式整理。
审查、验证、合入后沿用同一套个人版本发布与运维升级流程。
暂时没有具体二开需求，保持产品功能不变。
