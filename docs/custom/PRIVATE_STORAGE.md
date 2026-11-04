# Cloudreve 私密存储接口 v1

本次在 2.7.7 个人版上新增可选私密存储，用于 Cloudreve 的 `cloudreve-test/` 目录。普通上传不设置 `access=private` 时沿用原流程，原图片不迁移，公开链接和渠道设置不变。

## 先选择不会公开文件的渠道

首轮联调使用 Docker 的 `cfr2:R2_env`，它将文件写入持久化的 `data/r2/`，不是 Cloudflare 云端 R2。保留现有默认渠道及公共域名，不要为这次测试改动旧桶权限。

服务器环境变量默认空，即关闭私密上传。要启用，明确设置：

```dotenv
IMGBED_PRIVATE_STORAGE_CHANNELS=cfr2:R2_env
```

应用同时要求该名称对应已启用渠道，且没有 `publicUrl`、`cdnDomain`。S3 仅能另建**非公开专用 Bucket**后使用，例如 `s3:cloudreve_private`。环境变量是管理员确认此渠道不公开的许可，不会检查或修改云厂商 Bucket ACL、桶策略与其他访问入口。

API Token 由用户在图床管理页面创建，需要 `upload`、`manage`、`delete`。仅填入本机 Cloudreve 管理页面；不写进命令、文档或聊天。现有全局 AUTH_CODE 不能替代此 Token。

## 客户端协议 v1

1. 先以 Bearer Token 请求 `GET /api/manage/storageCapabilities`，响应必须含 `version:1, privateUpload:true`。Cloudreve 在旧服务上会先报错，不写入文件。
2. 上传为单个 multipart `file`，请求 `POST /upload`，参数：

   | 参数 | 值 |
   | --- | --- |
   | `access` | `private` |
   | `uploadChannel` | `cfr2` 或 `s3` |
   | `channelName` | 精确渠道名，不能缺省或回退 |
   | `uploadFolder` | `cloudreve-test/<Cloudreve用户ID>` |
   | `uploadNameType` | `origin` |
   | `autoRetry` | `false` |
   | `storageUploadId` | 稳定的 Cloudreve 上传会话 ID |

   物理名为安全 ASCII UUID；中文显示名、移动、改名保存在 Cloudreve。私密路径不支持分片初始化、合并和清理入口。首次写入即带 `Access:private`、`ListType:Block`、`StorageUploadId`，不向外部内容审核服务发送私密文件。
3. 同一路径重试时，已有记录的私密状态、操作 ID 和字节大小全部匹配才返回原路径；冲突为 409，不生成 `(1)` 文件。该约定用于**单 Cloudreve 实例、独占目录**，不提供跨实例事务或分布式 CAS。
4. 成功响应包含 `access:private`、`storageUploadId`；读取响应带 `X-Imagebed-Upload-Id`，客户端通过 HEAD 核对归属与长度。
5. `GET/HEAD /file/<物理路径>?from=admin` 仍必须有真实 manage Token 或有效管理员会话。匿名普通链接及仅添加 `from=admin` 均不可读。私密内容 `no-store`，支持 Range；S3 通过桶 API 读取，HEAD 使用 HeadObject。
6. 删除继续使用既有管理接口，只删除明确文件；Cloudreve 同时检查 HTTP 状态与业务成功字段。

## 本地验证与发布前检查

```bash
node --import ./deploy/server/register.mjs --test tools/custom/tests/private-upload.mjs tools/custom/tests/private-storage-handler.mjs
```

测试执行真实上传/读取 handler，KV、R2 和 S3 SDK 为模拟边界，不访问生产图床。覆盖私密默认关闭、权限和渠道拒绝、普通上传兼容、重试原路径、HEAD 长度/归属、Range、匿名拒绝及 S3 绕过公共 CDN。

个人镜像工作流已加入这两份测试，在 smoke 容器内运行；发布仍需原有构建、认证、普通上传和重启测试。容器检查结果以该工作流为准，不能将本地 handler 测试视为容器验收。

## 升级和回退

服务器操作见配套 `server-ops/imgbed/PRIVATE_STORAGE_UPGRADE.md`。本次未新增 DDL；私密状态附加在现有文件 metadata 中。

旧版不理解 `Access:private`。新文件虽设置 `ListType:Block`，仍不能把旧版当作新私密协议的等价实现。产生私密文件后，不直接切旧镜像继续提供这些文件：停止 Cloudreve 写入，保留升级后完整数据离线，按升级前快照恢复到新的专用目录。首轮使用本地 R2 的对象随完整 app 快照恢复；外部 S3 对象需单独隔离与核对。不要删除故障现场或使用 `down -v`。
