# ARCHITECTURE

## 目标组件与数据流

浏览器挂载 BlockSuite，Yjs 承载文档状态。Node.js 单进程提供静态资源、空间邀请和权限、WebSocket 同步与保存确认；SQLite 和独立附件目录负责持久化。当前只支持一个共享空间、一个服务实例。

## 当前实现

本地验证壳为 TypeScript、Lit 与 Vite 6.4.4；@blocksuite/affine 0.22.4、Yjs 13.6.33 通过完整 Store/View 扩展管理器挂载，保持正文与画板共用文档。具体能力与版本依据见 EDITOR_CAPABILITIES，取舍见 DECISIONS ADR-003。

src/editor 共享完整原生编辑器与宿主服务适配。src/app 使用自行实现的 ProductionWorkspace/ProductionDoc、独立 Y.Doc、IndexedDB 和带保存确认的 WebSocket 同步；目录来自服务端，标题从原生 page 块投影到 SQL。生产入口为 /，src/lab 的 test-only TestWorkspace 仅在 /lab.html 使用。

发布包导出 TypeScript 源码。Vite 使用上游同类 WASM 与 vanilla-extract 插件，保留原生 effects。宿主类型检查通过 scripts/check-types.mjs 映射到同版本随包发布的声明文件，避免把第三方源码内部诊断混入宿主检查；运行构建仍使用原始源码。useDefineForClassFields 与上游保持 false，库类型支持 ESNext。

开发预构建排除原生源码包，保留 .css.ts 插件处理；通过 TypeScript AST 收集其外部运行入口，转换 CommonJS 与深层依赖；显式编译装饰器。实际接入事件见 MEMORY。

依赖审计发现旧传递依赖 KaTeX 与 Vitest 问题。锁定覆盖为 KaTeX 0.18.2、Vitest 4.1.11；实际构建和公式渲染分别验证，不能以审计零报告替代行为验收。React 18.3.1 仅用于满足上游图标模块 peer，宿主使用 Lit。构建保留第三方许可原文。

## 保存与离线边界

IndexedDB 原子保存合并快照与待发增量；不同标签页的确认只删除对应增量。附件按成员和空间代际缓存，已读附件也保存到本机。构建时生成 Service Worker 预缓存应用、字体和编辑器资源，API 始终直连服务端。实现依据见 [Yjs 离线支持](https://docs.yjs.dev/getting-started/allowing-offline-editing)。

重连数据流为本机草稿准备、当前身份和文档状态核验、获准的 Yjs 更新交换、服务端持久化及保存确认。文档增量同步依据公开 [Yjs 更新接口](https://docs.yjs.dev/api/document-updates)；正常合并与异常保留行为以 PRD 为准。

HTTP、WebSocket 与附件访问共用权威成员和权限状态，成员角色及文档生命周期由服务端控制。查看连接只接收获准内容，客户端提交的协同数据不能自行修改授权。删除、撤权与备份恢复需要阻断旧连接和旧离线稿自动写回。

正文和附件分别产生保存确认，未上传附件会阻止整体显示云端已保存。备份包含同一数据库快照中的目录、权限和附件索引，并复制其不可变文件；恢复到全新目录。同步事件不能解释为保存确认，具体恢复验收见 PRD。

## 已实现的生产基础方案

依据 DECISIONS ADR-009，服务端为 Node.js 22 单实例，SQLite WAL 与 synchronous=FULL，附件独立目录。SQLite 表管理成员、会话、邀请、文档生命周期、Yjs 快照与增量、附件索引及空间恢复代际。权限和文档目录不由客户端 Yjs 数据控制。

同步使用版本化 WebSocket 消息，先核验 Cookie、Origin、当前成员、空间代际及文档代际，再按状态向量返回增量。写入在同一同步事务内复核资格、校验更新、落盘并产生修订号，提交后广播和回复保存确认。重复更新安全重试，保存失败不污染权威内存状态。

删除及恢复均推进文档代际，恢复备份推进空间代际；旧客户端须保留离线稿并停止自动写回。每个消息及对外广播均复核授权，撤权主动终止现存连接。心跳和重连对账处理半开连接。

附件先写受限临时文件，校验内容地址并同步文件，原子发布后再提交索引。提交前再次核验权限，配额或 SQL 失败时清理本次新建的未索引文件，不删除已有附件；进程中途崩溃仍可能留下孤儿文件，启动扫描与回收待补齐。备份使用 SQLite 在线备份并复制不可变附件，恢复到新目录后默认暂停访问、失效旧凭据和重审成员资格。

浏览器持久层按成员、空间和文档代际隔离缓存；重连前保存完整离线稿，身份切换、降权或代际变化时停止自动上传。每次核验当前成员后，同步更新原生 Store 的只读状态和本机身份元数据，离线重开沿用最后核实的角色；缓存中不存认证凭据。已有缓存时先加载本机内容，无缓存时先等待首轮同步再挂载原生编辑器。删除或恢复时保留旧 Doc 的离线导出，并使用新代际打开恢复内容。

依据 ADR-011，成员资格历史由服务端权限版本表达；SQLite 采用增列迁移，不重建成员数据。IndexedDB 升级到版本 2，新增按文档作用域保存的授权版本与暂停原因。异常暂停不能靠刷新或恢复会话消除；无授权记录的旧待发队列保留并暂停。用户明确重新读取云端时，在同一本机事务中先保存完整旧稿，再隔离原队列和缓存，以新的 Y.Doc 读取云端；旧内存和草稿继续可导出。旧空间代际的正文及附件可一并导出。离线附件记录产生时的权限版本，身份失效后暂停或授权版本不匹配的附件保留供导出，不自动上传。

本机回归使用 fake-indexeddb 6.2.5 测试实际持久层代码，另由真实 HTTP 过期测试驱动 DocumentSync；该依赖仅用于开发测试。浏览器持久保存与恢复效果仍以独立浏览器操作和实际导出文件为证据。

Awareness 当前仅保留本机状态，远端光标和在线成员传输待实现。独立双浏览器的正文、基础画板图形、离线重连和降权已有行为证据，具体边界见 EDITOR_CAPABILITIES；原生全部格式往返、附件浏览器流程、本机存储失败注入和真实容量仍待验收。应用资源缓存暂不自动清理旧版本，需补齐可控资源回收与存储压力验证。

公开依据：[SQLite WAL](https://www.sqlite.org/wal.html)、[同步强度](https://www.sqlite.org/pragma.html#pragma_synchronous)、[better-sqlite3](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3)、[ws 鉴权示例](https://github.com/websockets/ws#client-authentication)、[Yjs 更新接口](https://docs.yjs.dev/api/document-updates)。具体已实现接口和验证结果随代码同步 SPEC、CHANGELOG。

## 禁改

不得以 Markdown 投影替代完整文档真相源。不得让客户端自行决定成员权限。重大取舍先记录 DECISIONS。
