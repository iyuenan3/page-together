# SPEC

## 当前状态

以下为当前代码已经实现的契约，类型见 shared/protocol.ts，入口见 server/app.ts。首版一个共享空间，协议 v1，二进制使用标准 Base64；时间戳为 Unix 毫秒。

## 身份与 HTTP

邀请和恢复码只在兑换时提交，数据库只存摘要。HTTPS 会话为 __Host-pt_session，HttpOnly、Secure、SameSite=Strict、Path=/；回环 HTTP 测试使用 pt_session。写请求和 WebSocket 必须匹配配置 Origin，不接受跨源写入或 CORS。

JSON 请求上限 16 KiB，失败返回 HTTP 状态和 {code}，不返回内部异常。资源 ID 仅接受字母、数字、下划线和连字符。成员为 {id,nickname,role,owner,active,accessRevision}，role 为 manage/edit/view。accessRevision 从 0 开始，角色或活跃资格实际变化时递增；恢复会话不重置该值，无变化的角色保存不递增。该字段补充协议 v1 的成员信息，不能作为客户端认证凭据。

应用静态模块（含 PDF worker 的 .mjs）使用 text/javascript，WASM 使用 application/wasm，并保留 X-Content-Type-Options: nosniff。静态程序和字体资源可缓存；附件内容仍经已鉴权 API 或本成员缓存读取，没有新增公开附件 URL。

同源根路径的 `?doc=:id` 和原生 `/workspace/main/:id` 均可导航到目录中当前获准访问的文档。后者仅返回公开应用壳，不返回正文；其他 workspace 路径不作通配回退。不存在或已删除的目标明确提示，不能借链接恢复文档或跳过 API 鉴权。

定位查询接受 `mode=page|edgeless`、逗号分隔的 `blockIds` 或 `elementIds`、`databaseId`、`databaseRowId` 和 JSON 数组 `xywh=[x,y,w,h]`。标识去重后每组最多 100 个，每个最多 512 字符；坐标须为有限数、绝对值不超过 1e9，宽高为正。无效参数丢弃，仍允许打开获准文档。当前聚焦首个标识，画板无标识时可按坐标聚焦；定位目标缺失则打开文档并提示。链接跳转、初次加载和历史导航使用同一解析，不能改变授权或生命周期。

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
| PUT /api/blobs/:key | 编辑以上上传原始字节，必须携带下述上传作用域；校验内容地址、限额与当前权限，索引提交后返回 {key,size,saved:true} |
| GET /api/blobs/:key | 有效成员下载已索引附件，可携带预期空间代际；撤权终止现存下载 |
| POST /api/maintenance/resume | 仅所有者解除备份恢复后的暂停状态 |

文档目录为 {id,title,generation,revision,deleted,createdAt}。标题通过原生 page 块的 Y.Text 修改，与正文一起保存，SQL 目录为其投影。创建目录和初始化原生内容是两个步骤；未初始化内容不能直接挂载编辑器，其异常修复入口仍待补齐。

附件键遵循 BlockSuite 的 SHA-256 Base64URL 格式，保留末尾等号；请求路径需编码。附件不存在返回 404，哈希错误返回 400，单附件或总配额超限返回 413，并发上传忙返回 429。没有公开下载地址或永久删除接口。

PUT 必须携带 `X-PageTogether-Upload`，值为 JSON `{docId,epoch,generation,memberId,accessRevision}`，最长 2048 字符。接收前、异步文件工作后及索引事务内均核验身份、权限版本、空间代际和当前未删除的文档代际；成员或权限版本不符返回 409 `access_changed`，代际及删除错误沿用文档错误。缺失头返回 400 `upload_context_required`，格式非法返回 400。该契约收紧了原上传接口，旧页面须刷新至配套构建后上传；WebSocket 协议仍为 v1。

GET 可携带 `X-PageTogether-Epoch`，与当前空间代际不符返回 409 `space_epoch_changed`。原生客户端使用此头并在写缓存前核对大小和 SHA-256；缓存及下载链接不作为认证凭据。已存在的同内容附件可重复提交，但每次仍须通过当前上传作用域核验。

## WebSocket 同步与保存确认

/api/sync 复用会话和 Origin。ready 返回当前 member 和空间 epoch。每个 open/push/awareness 均包含 {v:1,requestId,docId,epoch,generation}，并在操作时核验当前成员及生命周期。

- open 带 stateVector，sync 返回缺少的 update、服务端 stateVector 和 revision。
- push 带 update，必须已 open；服务端在 SQLite 同步事务内校验、保存并推进 revision。
- 提交成功后 saved 返回原 requestId、updateHash（SHA-256 十六进制）、revision 和完整文档作用域，再向获准订阅者广播 update。
- 客户端核对作用域和摘要，只删除该请求包含的待发记录。重复 Yjs 更新可安全重试，不重复推进修订号。
- catalog 提示重新读取目录；错误为 {v:1,type:error,requestId?,code}。数据库提交失败不发 saved 或广播，不污染后续拉取结果。

权限版本或会话失效关闭连接，文档删除或代际改变关闭旧订阅。典型错误为 session_expired、read_only、space_epoch_changed、document_deleted、document_generation_changed、storage_unavailable；客户端保留离线稿，网络或存储服务故障重试，身份或生命周期异常暂停上传。暂停跨刷新及身份恢复生效；有待发修改且授权版本变化或缺失时不自动上传，即使当前角色已恢复编辑。

awareness 的 update 为标准 Awareness 二进制的 Base64，客户端单次仅提交自身一条状态，解码上限 16 KiB；须先 open 相同文档作用域。服务端将客户端 ID 绑定到该连接，拒绝覆盖其他连接的 ID，昵称、成员 ID、角色和颜色由服务端生成。仅保留本版本的原生 text/block/image/cursor/surface 选择结构，限制条目和字段大小。查看成员可发送获准的远端状态，不能借此写正文。

open 后返回该房间已有状态；临时状态变化和离开均向当前获准订阅者广播同作用域 awareness。撤权、会话失效或文档代际变化清除该连接状态。Awareness 不产生 saved、修订号或数据库写入，不代表正文已保存。当前文档在线人数按成员去重，多个页面另行提示；切换文档退出原文档活跃状态，离线不显示过时人数。

本机正文写入或待发确认清理失败时持续显示保存失败，保留内存并暂停上传；明确重试先保存完整内存快照，再恢复获准的同步。异常暂停与存储失败分别保存状态，重试存储不能解除异常授权暂停。离线稿只读对照不修改源数据；人工追加使用当前已核验的编辑身份和文档代际，先保存目标快照，再添加用户确认的文字，不能直接应用整个旧 Yjs 更新或覆盖当前文档。

当前每个已打开文档持有独立连接。本机验证已覆盖 10 人各 4 条连接共 40 条，主文档含 1000 个段落，其余 3 篇为空文档；超过该打开文档数或多个设备的容量仍待测，完整固定方案见 [CAPACITY](CAPACITY.md)。

引用本机待发附件的正文等待该附件的服务端保存确认及本机回执写入。网络失败保留队列并重试，配额异常可明确重试；身份、权限或生命周期异常持久暂停。明确重新提交附件前，在同一本机事务中保存原始副本及新的待发记录，再按当前作用域上传并追加卡片。旧空间附件、原始副本及异常正文继续保留，旧上传回执只能确认其对应的本机队列记录。

## 内容导入导出

原生内容包为 ZIP，包含 `*.snapshot.json`、`assets/` 和 `pageTogether.json`。清单为 `{format:1,blockSuite:"0.22.4",assets:[{key,path,type,name?}]}`，快照使用该版本公开 DocSnapshot。支持单独导入兼容的原生 JSON；存在附件引用时必须提供完整资源包。块类型、版本、根节点、父子关系、块 ID 唯一性和附件完整性在创建任何文档前校验，单篇最多 20000 块。

导入始终创建新文档，预分配 ID 后重映射包内行内、卡片、同步嵌入及画板引用的文档 ID；块、图形、画框和数据表标识保留，包外引用不改写。已有文档不覆盖。导入须联网并重新核验当前编辑身份，实际写入和附件继续经已有鉴权与保存确认；中途权限变化或失败暂停后续处理，保留已创建内容，不自动回滚删除。

原生导入保留快照中的块创建及修改元数据，不用导入时刻或当前成员覆盖。新建记录继续由当前编辑身份产生原生元数据，创建时间字段只读；缺失历史元数据的旧记录初始为空，后续编辑可能由原生服务记录当次时间，不能据此认定其历史创建时间。

Markdown、HTML、TXT 使用原生适配器；复杂原生内容可能投影为静态表格、文字或丢失交互。含图片的 Markdown/HTML 导出 ZIP，资源路径与文内 URL 一致。Notion HTML 通过明确选项启用原生专用解析，并按源文件相对路径处理包内链接；没有宣称支持所有 Notion 导出。PNG/PDF 使用原生视觉导出，不包含可编辑原生数据。

静态数据表投影将标题表头与原生适配器的首列标题值对齐，创建时间按 `+08:00` 文本导出；这些转换仅作用于导出副本。金额、百分比导出原始数值，筛选、显示格式及交互不随静态表格保留。实际复杂格式损失及原生往返对照见 EDITOR_CAPABILITIES，不将文本包当作完整备份。

每批最多 100 篇支持格式文档、2000 个压缩条目；输入 ZIP 和实际解压总量各最多 100,000,000 字节，单个条目及附件最多 50,000,000 字节，单篇文本或原生 JSON 最多 10,000,000 字节。拒绝不安全或重复路径、不完整压缩包、未支持的压缩方法及嵌套 ZIP；UTF-8 严格解码。原生附件按内容键验证 SHA-256，缺失或不符时不创建文档。导出也检查内容大小，不能把限额当作完成相应容量验收。

这些是浏览器内容迁移边界，服务端 8 MiB 正文、空间文档数、附件配额和 40 条连接保护独立生效。本轮完整往返为 25 篇文档及 6 个附件，空间导出加载的文档也会占用连接；更大批次或多人同时迁移仍待测。服务身份、权限与完整恢复使用 server:admin 备份，不包含在此内容包内。

## 保存、备份和资源边界

正文使用 SQLite WAL、synchronous=FULL，快照加增量日志。每 32 次更新或日志达到正文限额两倍时压缩。保存确认仅代表当前服务器磁盘提交，不代表异机备份完成。

server:admin 支持 init、backup、restore。初始化无公网入口；备份输出到全新目录，清单最后写入，包含数据库与全部索引附件的摘要。恢复也必须使用全新目录，完整性验证后轮换空间 epoch 和所有者恢复码，清除会话与邀请，暂停访问并停用非所有者。具体命令见 README，恢复旧备份后的资格复核见 PRD。

当前保护默认值：正文及单次更新 8 MiB、256 篇文档（含回收站）、50 MB 单附件、2 GiB 附件总配额、40 条连接、2 个并发上传、每连接每秒 60 条消息。身份尝试为每来源地址每分钟 20 次，不信任任意转发地址。正文、文档数、附件限额、连接数及 7 天邀请和 30 天会话可通过服务环境变量配置。这些是初始保护值，未完成目标环境测量。

## 验证边界

77 项集成与回归测试覆盖增量合并、保存失败、权限、生命周期、附件、备份恢复及确认后进程崩溃读回，另覆盖本机隔离和升级、真实 IndexedDB 事务中止与确认清理失败、暂停保护、Awareness 身份绑定与离开清理、原生文本投影比较。附件与预览回归覆盖并发队列、迁移、故障、授权及生命周期变化、撤权下载中断、类型和 UTF-8 边界、混合 drop、PDF 画布与 worker MIME、行内空白及信号订阅隔离。原生创建、目录竞态、ZIP 限制、引用映射与 Notion 路径回归继续通过。本轮增加定位参数往返、原生嵌套筛选连续更新与字段选择、数字格式编辑、静态表头和创建时间投影；使用固定上游实际源码及未修复源码对照验证缺陷，版本或片段漂移使构建明确失败。

独立 Chrome 与内置 Chromium 的系统输入、PDF、文档引用、数据表、实际下载与导入、原生往返、查看保护和服务重启读回证据见 EDITOR_CAPABILITIES。本轮复杂包另覆盖 3 篇、60 个块及 2 个附件；数据表、正文与双画框定位通过，数据库行和坐标定位尚未单独浏览器验收。会话过期使用服务端可控时钟触发，未测试真实等待 30 天后的浏览器 Cookie 清除。本机短时容量沿用 CAPACITY；画板系统拖入、其他原生能力与格式、长期压力和 ECS 容量仍待验收。此次未改变身份、附件或 WebSocket 契约及默认保护限额。

权限矩阵、身份恢复和离线重连的产品行为以 PRD 为准，组件与数据流见 ARCHITECTURE。
