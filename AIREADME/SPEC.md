# SPEC

## 当前状态

以下为当前代码已经实现的契约，类型见 shared/protocol.ts，入口见 server/app.ts。首版一个共享空间，协议 v1，二进制使用标准 Base64；时间戳为 Unix 毫秒。

## 身份与 HTTP

邀请和恢复码只在兑换时提交，数据库只存摘要。HTTPS 会话为 __Host-pt_session，HttpOnly、Secure、SameSite=Strict、Path=/；回环 HTTP 测试使用 pt_session。写请求和 WebSocket 必须匹配配置 Origin，不接受跨源写入或 CORS。

JSON 请求上限 16 KiB，失败返回 HTTP 状态和 {code}，不返回内部异常。资源 ID 仅接受字母、数字、下划线和连字符。成员为 {id,nickname,role,owner,active}，role 为 manage/edit/view。

| 接口 | 行为与权限 |
|---|---|
| POST /api/auth/invite | {token,nickname}，一次兑换，签发会话 |
| POST /api/auth/recover | {code}，恢复所有者并返回新 recoveryCode，旧码和旧所有者会话失效 |
| GET /api/session | {member,epoch,paused}，恢复维护时仅所有者可访问 |
| POST /api/logout | 失效当前会话并清 Cookie |
| GET /api/members | 当前成员列表，任何有效成员可读 |
| POST /api/invitations | 管理者提交 {role,memberId?,recovery?}，返回 {id,token,expires}；仅所有者可为原成员恢复身份或增加设备 |
| DELETE /api/invitations/:id | 管理者撤销邀请 |
| PATCH /api/members/:id | 管理者提交 {role,active}；任免管理者仅所有者可执行，不能降级或移除所有者 |
| GET /api/documents | 有效成员读取目录；?trash=1 仅管理者可读 |
| POST /api/documents | 编辑以上提交 {id,title}，同 ID 重试返回已有文档，不能复活回收站文档 |
| POST /api/documents/:id/trash 或 restore | 管理者推进生命周期及文档代际，不永久删除 |
| GET /api/blobs | 有效成员读取已提交附件键列表 |
| PUT /api/blobs/:key | 编辑以上上传原始字节，校验内容地址、限额与当前权限，索引提交后返回 {key,size,saved:true} |
| GET /api/blobs/:key | 有效成员下载已索引附件，撤权终止现存下载 |
| POST /api/maintenance/resume | 仅所有者解除备份恢复后的暂停状态 |

文档目录为 {id,title,generation,revision,deleted,createdAt}。标题通过原生 page 块的 Y.Text 修改，与正文一起保存，SQL 目录为其投影。创建目录和初始化原生内容是两个步骤；未初始化内容不能直接挂载编辑器，其异常修复入口仍待补齐。

附件键遵循 BlockSuite 的 SHA-256 Base64URL 格式，保留末尾等号；请求路径需编码。附件不存在返回 404，哈希错误返回 400，单附件或总配额超限返回 413，并发上传忙返回 429。没有公开下载地址或永久删除接口。

## WebSocket 同步与保存确认

/api/sync 复用会话和 Origin。ready 返回当前 member 和空间 epoch。每个 open/push 均包含 {v:1,requestId,docId,epoch,generation}，并在操作时核验当前成员及生命周期。

- open 带 stateVector，sync 返回缺少的 update、服务端 stateVector 和 revision。
- push 带 update，必须已 open；服务端在 SQLite 同步事务内校验、保存并推进 revision。
- 提交成功后 saved 返回原 requestId、updateHash（SHA-256 十六进制）、revision 和完整文档作用域，再向获准订阅者广播 update。
- 客户端核对作用域和摘要，只删除该请求包含的待发记录。重复 Yjs 更新可安全重试，不重复推进修订号。
- catalog 提示重新读取目录；错误为 {v:1,type:error,requestId?,code}。数据库提交失败不发 saved 或广播，不污染后续拉取结果。

权限或会话失效关闭连接，文档删除或代际改变关闭旧订阅。典型错误为 session_expired、read_only、space_epoch_changed、document_deleted、document_generation_changed、storage_unavailable；客户端保留离线稿，网络或存储服务故障重试，身份或生命周期异常暂停上传。

Awareness 暂未进行网络传输。当前每个已打开文档持有独立连接，连接数保护不能解释为已通过 10 人多文档容量验收。

## 保存、备份和资源边界

正文使用 SQLite WAL、synchronous=FULL，快照加增量日志。每 32 次更新或日志达到正文限额两倍时压缩。保存确认仅代表当前服务器磁盘提交，不代表异机备份完成。

server:admin 支持 init、backup、restore。初始化无公网入口；备份输出到全新目录，清单最后写入，包含数据库与全部索引附件的摘要。恢复也必须使用全新目录，完整性验证后轮换空间 epoch 和所有者恢复码，清除会话与邀请，暂停访问并停用非所有者。具体命令见 README，恢复旧备份后的资格复核见 PRD。

当前保护默认值：正文及单次更新 8 MiB、256 篇文档（含回收站）、50 MB 单附件、2 GiB 附件总配额、40 条连接、2 个并发上传、每连接每秒 60 条消息。身份尝试为每来源地址每分钟 20 次，不信任任意转发地址。正文、文档数、附件限额、连接数及 7 天邀请和 30 天会话可通过服务环境变量配置。这些是初始保护值，未完成目标环境测量。

## 验证边界

集成测试覆盖独立会话的增量合并、失败提交、重试、权限、生命周期、附件与备份恢复，以及保存确认后 SIGKILL 并以新进程读回。真实浏览器覆盖原生正文保存、服务不可达时修改并刷新、自动重连、首次无缓存加载及回收站流程。独立浏览器、远端选择、本机保存失败注入、完整原生格式和正式容量仍待验收，见 CHANGELOG。

权限矩阵、身份恢复和离线重连的产品行为以 PRD 为准，组件与数据流见 ARCHITECTURE。
