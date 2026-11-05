# ImageBed 统一私密存储接口

Cloudreve 只填写 ImageBed 地址、API Token 和专用目录。实际存储由 ImageBed「网页设置 → 客户端设置 → 默认渠道类型 / 默认渠道名称」决定；未设置时沿用默认 Telegram 和首个启用渠道。原有公开上传及旧图片不迁移、不改变权限。

## 沿用现有 Telegram

保留现有 Bot 和存储频道。私密上传使用启用的默认 Telegram 渠道，通过 getChat 拒绝带公开用户名的频道/超级群；个人私聊不因对方有用户名而被拒绝。频道成员仍可在 Telegram 查看文件，应控制成员范围。

私密文件按原始 document 上传，不压缩图片、不转换动画、不发送内容审核。超过 16 MiB 时由 ImageBed 内部分片；Cloudreve 仍只上传一次。首轮 Cloudreve 单文件上限为 100 MiB。

Telegram 不需要 `IMGBED_PRIVATE_STORAGE_CHANNELS`。此前配置的 `cfr2:R2_env` 可保留，不会把 Telegram 文件转存服务器磁盘。

若 ImageBed 默认选择 R2/S3，仍需此环境变量显式允许非公开渠道，且不能配置 publicUrl/cdnDomain；S3 管理员需确认桶不公开。Docker 的 R2_env 是服务器本地磁盘。默认渠道不存在、禁用、超额或不支持时明确失败，不切其他后端。

API Token 需要 upload、manage、delete，由用户在图床创建并在本机 Cloudreve 填写，不写进命令、文档或聊天。AUTH_CODE 不能替代它。

## 客户端协议

1. Bearer Token 请求 GET /api/manage/storageCapabilities，需包含 `version:1, privateUpload:true, serverSideRouting:true`。新 Cloudreve 在旧服务上先报错，不写文件。version:1 保留，旧显式 R2/S3 客户端继续可用。
2. 单个 multipart file 请求 POST /upload：access=private、uploadNameType=origin、uploadFolder=cloudreve-test/<用户ID>、autoRetry=false、storageUploadId=稳定会话ID。客户端不发送 uploadChannel/channelName，由 ImageBed 解析自身默认配置。物理名为安全 ASCII UUID，显示名及整理由 Cloudreve 管理。私密接口不支持客户端分片初始化/合并/清理；Telegram 内部分片属于同一次服务端上传。
3. 首次记录即带 Access:private、ListType:Block、StorageUploadId。同路径重试须匹配私密状态、操作 ID、字节大小，否则409，不生成(1)文件。限单 Cloudreve 实例、独占目录，不提供分布式 CAS。
4. 成功响应含 access:private、storageUploadId，不返回公开 CDN URL。读取带 X-Imagebed-Upload-Id，客户端 HEAD 核对长度及归属。
5. GET/HEAD /file/<物理路径>?from=admin 仍需真实 manage Token 或有效管理员会话。匿名直链及只加 from=admin 均拒绝；内容 no-store。Telegram HEAD 从上传时验证的元数据返回长度，GET 保真并支持完整、开区间、后缀、跨片 Range。历史文件按记录渠道读取，不跟随上传默认值变更。
6. 删除沿用 ImageBed 管理接口，Cloudreve 检查 HTTP 与业务成功字段。**Telegram 删除是移除 ImageBed 记录和读取入口，不撤回频道消息或承诺 Telegram 物理擦除**，与原图床语义一致。R2 删除本地/桶对象。

## 验证

```bash
node --import ./deploy/server/register.mjs --test tools/custom/tests/private-upload.mjs tools/custom/tests/private-storage-handler.mjs tools/custom/tests/private-telegram.mjs
```

测试运行真实 handler，KV/R2/S3 SDK/Telegram 为模拟边界，覆盖默认路由及失败、公开频道拒绝、权限、普通上传兼容、图片字节保真、16 MiB 跨片、HEAD/Range、重试、匿名拒绝和逻辑删除。个人镜像工作流在容器内执行，并保留普通上传、认证、重启检查。真实频道仍需用户升级后联调。

## 升级和恢复

沿用 GitHub Actions → GHCR 固定镜像 → 服务器 update.sh，操作单在 server-ops/imgbed/PRIVATE_STORAGE_UPGRADE.md。不上传源码包、不新增 DDL。

旧版不理解私密状态。产生私密文件后，不直接将新数据交给不支持协议的旧镜像；停止 Cloudreve 写入，保留升级后完整数据，按升级前快照恢复到新专用目录。数据库快照不含 Telegram 消息和外部 S3 对象，需另行核对。不删库、不清卷、不丢弃故障现场。
