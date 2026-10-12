# 编辑器能力与验证基线

## 版本

2026-10-09 核对公开上游。当前本地验证基线为 `@blocksuite/affine@0.22.4`，对应 [v0.22.4](https://github.com/toeverything/blocksuite/releases/tag/v0.22.4)、提交 `a5091e72365a47351f370ca23f212ef43a9d42f0`。BlockSuite 编辑器与框架包须保持同代，不能混入旧 `@blocksuite/presets@0.19.5`；图标包采用上游独立版本 2.2.17。Yjs 固定 13.6.33，锁文件与安装图确认单一实例。

AFFiNE 开发版在固定提交 `2d4f191e679a1eb95f96fe12b95060deb35668ae` 内包含 BlockSuite 0.27.5。相对发布基线，默认 schema 和 store 扩展名单相同，view 清单增加原生行内评论，另有 comment、tooltip、clipboard 导出变化。名单相同不证明实现行为相同。见 [开发版包清单](https://github.com/toeverything/AFFiNE/blob/2d4f191e679a1eb95f96fe12b95060deb35668ae/blocksuite/affine/all/package.json)。

当前先验证可复现的发布包，生产版本仍以完整挂载和能力验收结果决定。`src/lab` 使用上游明确标为 test-only 的 `TestWorkspace`，禁止沿用为生产保存实现。

## 完整清单

本表为静态源码盘点。注册扩展不代表入口、持久化或权限验收通过，具体运行结果在末尾登记。

| 类别 | 上游能力 | 宿主工作与验收 |
|---|---|---|
| 正文与画板 | Page、Edgeless | 模式、容器、主题、字体；两种模式往返编辑 |
| 正文块 | 段落、H1 至 H6、引用、折叠、分隔线、Callout；项目符号、有序、待办列表 | 原生菜单与快捷键、嵌套与重开；旧 toggle 保留兼容但已弃用 |
| 行内格式 | 粗体、斜体、下划线、删除线、代码、文字与背景色；链接、脚注、公式、文档引用、提及 | 元数据、成员查找、跳转；格式和粘贴验证 |
| 代码与公式 | 代码块、LaTeX 块与行内公式 | 高亮、公式依赖和静态资源 |
| 表格与数据 | table、database、data-view；表格与看板；文本、数字、单选、多选、日期、勾选、图片、进度 | 单元格、属性、视图切换与保存 |
| 图片与附件 | 图片、附件块、Blob 同步接口 | 上传、下载、预览、限额、权限和恢复 |
| 画板工具 | 指针、笔刷、Note、形状、连接、分组、文字、思维导图、模板、图形链接；Frame、Surface、SurfaceRef、EdgelessText | 工具可达、字体与模板资源；创建、移动、缩放、同步和重开 |
| 嵌入 | YouTube、Figma、GitHub、Loom、HTML；Embed 模块另有 iframe 实现 | URL、预览、安全策略与外部加载；条件注册另核对 |
| 多文档 | 行内引用、LinkedDoc、SyncedDoc、SurfaceRef | 文档创建、查找、导航、权限和引用恢复 |
| 原生交互 | 选择、拖拽、斜杠菜单、工具栏、快捷键、远端选择、视口和滚动锚点、自动连接、缩放、NoteSlicer | 完整生命周期；真实浏览器、中文输入、粘贴与远端光标 |
| 辅助面板 | DocTitle、Outline、FramePanel、AdapterPanel | 宿主提供入口、文档上下文、导航和元数据 |
| 剪贴板与历史 | 剪贴板管线、块快照、撤销重做 | 不以 HTML 覆盖 CRDT；跨块粘贴、并发后撤销 |
| 导入导出 | Markdown、HTML、PlainText、Snapshot、Notion HTML/Text 适配器 | Transformer、DocCRUD、BlobCRUD、文件入口与失败提示；格式往返 |
| PNG 与 PDF | 画板 exportPng/exportPdf；正文浏览器打印辅助 | 图片 CORS、字体、尺寸与实际文件；画板 PDF 为画布图像，不能宣称矢量或可搜索文字 |
| 评论 | 0.22.4 提供 playground 锚点示例；0.27.5 增加原生行内评论扩展 | 线程、身份、权限、持久化及锚点恢复需接入 |
| AI 与 Word | 本轮未核实独立发布包完整 AI 服务或 DOCX 转换链路 | 按外部服务另核对版本、入口、费用和权限，不宣称已有 |
| 协同与保存 | Workspace、Doc、DocSource、BlobSource、AwarenessSource | 服务端鉴权、网络、CRDT/元数据/附件落盘、保存确认、独立备份恢复 |

## 注册覆盖

[AffineSchemas](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/affine/all/src/schemas.ts) 默认 25 项：Code、Paragraph、Root、List、Note、Divider、Image、Surface、Bookmark、Frame、Database、SurfaceRef、DataView、Attachment、EmbedYoutube、EmbedFigma、EmbedGithub、EmbedHtml、EmbedLinkedDoc、EmbedSyncedDoc、EmbedLoom、EdgelessText、Latex、Table、Callout。该清单不是条件扩展的上限。

[完整 View 清单](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/affine/all/src/extensions/view.ts) 包含 10 种画板扩展、6 种行内扩展、16 个 widgets 与 4 个 fragments。另有 turbo-renderer 包。验证页通过 `getInternalStoreExtensions` 和 `getInternalViewExtensions` 完整注册，禁止用少数手选块替代。

16 个 widgets：DragHandle、EdgelessAutoConnect、FrameTitle、KeyboardToolbar、LinkedDoc、RemoteSelection、ScrollAnchoring、SlashMenu、Toolbar、ViewportOverlay、EdgelessZoomToolbar、PageDraggingArea、EdgelessSelectedRect、EdgelessDraggingArea、NoteSlicer、EdgelessToolbar。

## 主要依据

- [官方编辑器挂载](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/integration-test/src/editors/editor-container.ts)、[playground 集合](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/playground/apps/starter/utils/collection.ts)、[服务适配](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/playground/apps/starter/utils/extensions.ts)。测试壳和 BroadcastChannel 不能证明服务器协同或保存。
- [完整 Store 清单](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/affine/all/src/extensions/store.ts)、[行内格式](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/affine/inlines/preset/src/inline-spec.ts)、[数据视图](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/affine/data-view/src/view-presets/index.ts)、[属性](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/affine/data-view/src/property-presets/pure-index.ts)。
- [格式适配器](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/affine/shared/src/adapters/index.ts)、[格式面板](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/affine/fragments/adapter-panel/src/config.ts)、[画板导出](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/affine/blocks/surface/src/extensions/export-manager/export-manager.ts)。
- [Workspace](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/framework/store/src/extension/workspace/workspace.ts)、[Doc](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/framework/store/src/extension/workspace/doc.ts)、[DocSource](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/framework/sync/src/doc/source.ts)、[BlobSource](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/framework/sync/src/blob/source.ts)、[AwarenessSource](https://github.com/toeverything/blocksuite/blob/v0.22.4/packages/framework/sync/src/awareness/source.ts)。

## 运行验证

2026-10-09，本地 Node 22.22.3、npm 10.9.8、Codex 内置 Chromium 浏览器。运行开发服务器与构建预览分别核验，浏览器动作直接触发原生编辑器，未用模拟编辑器替代。

| 验证 | 结果与边界 |
|---|---|
| 宿主类型检查 | npm run check 通过，检查同版本随包声明对应的宿主代码 |
| 生产构建 | npm run build 通过；完整编辑器入口体积较大，后续可按模块优化但不能裁能力 |
| 开发加载 | npm run dev 真实加载正文和画板；全新浏览器会话无 error，Lit 开发模式提示正常 |
| 中文输入与历史 | 正文直接输入、撤销和重做；模式切换后修改仍保留在当前内存 |
| 原生块菜单 | 菜单可达正文、列表、Callout、表格、数据视图、嵌入、附件、公式、Frame、Mind Map 等入口；出现入口不代表逐项完成验收 |
| 表格 | 从原生菜单创建 table，真实输入单元格中文，Markdown/HTML 输出包含该单元格 |
| 文档与引用 | 宿主创建、原生菜单 New Doc 创建、列表同步、引用点击跳转、修改标题和多文档往返通过 |
| 公式 | 原生 Equation 输入 E=mc^2；补齐 KaTeX 样式后正文与画板均正确显示，无重复排版 |
| 画板 | 原生图形工具拖动创建矩形，Add text 输入中文，选择与取消选择通过 |
| 辅助面板 | DocTitle、Outline、FramePanel、AdapterPanel 可达；大纲与画框空状态渲染通过，格式面板 Markdown/HTML 输出通过。复杂目录排序、演示和文件往返仍待验 |
| 依赖与许可 | Yjs 同一实例；修复覆盖后的 npm 安装审计为零报告项；构建生成第三方原始许可清单 |

仍未验收：全部原生项的完整行为、中文输入法组合事件、复杂表格与看板、附件和嵌入、原生格式文件往返、PNG/PDF 文件、评论与外部服务、大文档、跨浏览器协同和可靠保存恢复。当前页面使用 test-only 内存工作区，不能作为这些验收的证据。

## 生产工作区补充验证 · 2026-10-10

以下为新生产入口 / 的证据，不改写 2026-10-09 验证壳的历史结果。编辑器继续完整挂载同一版本 Store/View 扩展，生产工作区不使用 TestWorkspace。

真实内置 Chromium 浏览器验证：所有者恢复码兑换与轮换、原生标题和中文正文输入、云端保存后刷新读回、正文与画板往返。停止整个临时服务后继续编辑，显示本机保存；服务仍不可达时刷新，应用资源和修改均可读回。重启服务后自动合并并显示云端保存；另一个原生编辑器标签页读回并实时交换修改。此为同浏览器双标签页证据，不能替代独立浏览器验收。

回收站删除后旧页面停止同步并保留可导出内容；恢复后按新代际重新打开，完整正文可读。首次兑换邀请的新成员没有该身份的文档缓存，仍能完成首轮同步并渲染正文。无缓存挂载时序问题及修复见 MEMORY。

服务端以独立会话测试增量合并、保存确认、SQL 失败回滚、撤权、过期、生命周期与备份恢复。另以真实进程在保存确认后 SIGKILL 并重启读回；附件真实接收 50 MB，50 MB 加一字节返回 413。这些证据不能替代附件原生浏览器流程、10 人容量和断电恢复验收。

仍待验收：两个独立真实浏览器、远端光标与在线成员、本机存储失败、异常离线稿处理交互、附件全流程、正式容量与全部原生格式行为。此次独立 Chrome 自动化连接超时，未将尝试记为通过。

## 独立双浏览器补充验证 · 2026-10-11

使用内置 Chromium 和独立 Google Chrome，分别以管理者和受邀成员进入临时测试空间。两者使用独立会话与浏览器存储，直接操作原生编辑器。下表补充此前未通过的独立浏览器项，不改写历史结果。

| 验证 | 结果与边界 |
|---|---|
| 正文双向协同 | 两端分别输入中文，另一端实时收到；各自刷新后内容一致并显示云端保存。新成员首次访问没有该身份的文档缓存，仍完整渲染 |
| 基础画板协同 | 两端分别用原生工具创建图形，对端可见；服务端水合后的 Yjs Surface 确认保留两个 shape。仅证明基础图形交换，不代表全部画板工具验收 |
| 真正断网与重开 | Chrome 网络面板切换 Offline 后刷新，确认网络请求被阻断。离线新增内容没有到达另一端，在线端同时新增的内容也没有到达离线端；再次离线刷新，本机修改仍在 |
| 正常重连 | 恢复网络后自动合并双方独立增量，两端显示云端保存；Chrome IndexedDB 中保留重连前离线稿，待发记录在确认后清空 |
| 在线降权 | 编辑成员降为查看后，既有连接重新核验权限，原生正文和标题只读，粘贴尝试没有写入；仍能收到管理者后续修改 |
| 离线期间降权 | 成员在离线状态产生修改，管理者将其降为查看。重连显示同步暂停并保留离线稿；服务器读回确认这些修改没有被接收 |
| 已知查看角色的离线重开 | 复现实时降权后旧身份缓存仍记录编辑角色的问题。修复后用新成员重验，不先在线刷新，直接断网并重开，仍保持只读；粘贴尝试没有写入。根因见 MEMORY |
| 删除与恢复 | 管理者删除文档后，Chrome 旧页面停止同步并提示 document_deleted；恢复后 Chrome 从无缓存的新代际完整加载正文，没有自动复活旧代际 |
| 服务重启 | 停止并重启临时服务后，数据库读回保留双方正常增量及两个图形，未包含异常权限修改；内置浏览器刷新可完整读回。Chrome 重启后的页面读回尚未完成 |
| 构建与服务端回归 | 修复后 npm run build 和 11 项集成测试通过。既有服务端测试覆盖移除成员、过期会话及附件鉴权，但不能替代对应浏览器行为验收 |

本轮尚未完成 Chrome 在服务重启后的页面读回，以及移除成员后既有 Chrome 页面的停止访问检查，原因是系统锁屏阻断原生界面操作。临时测试数据和证据保存在忽略目录，不纳入公开仓库。

仍待验收：上述受阻步骤、会话失效与旧备份恢复的浏览器异常场景、远端光标与在线成员、本机保存失败注入、离线稿查看和恢复入口、原生附件全流程、正式容量及全部原生格式行为。当前结果不代表完整产品或目标 ECS 已通过验收。

## 重启读回与成员撤权补验 · 2026-10-12

系统解锁后恢复同一临时测试数据，完成上一条被阻断的两项步骤。继续使用独立 Chrome 成员会话和内置 Chromium 管理者会话，未通过修改浏览器存储或模拟页面结果替代真实操作。

| 验证 | 结果与边界 |
|---|---|
| Chrome 服务重启读回 | Chrome 刷新后完整读回双方此前的正文增量并显示云端保存；服务端水合结果仍包含两个图形，异常权限修改仍未进入服务器 |
| 既有页面撤权 | 管理者移除当前 Chrome 成员，既有页面显示需要恢复原成员身份、同步暂停并保留离线稿；管理者随后新增的内容没有出现在 Chrome 中 |
| 撤权后刷新及接口访问 | Chrome 刷新后回到邀请入口，仍提供本机离线内容导出入口。使用同一浏览器直接访问文档目录和附件列表接口，均返回 session_expired。此处未测试原生附件上传下载全流程 |
| 恢复资格与旧会话 | 在成员弹窗中恢复测试成员资格，原 Chrome 会话访问附件列表仍被拒绝；恢复资格没有复活已撤销会话。随后再次移除测试成员 |
| 成员弹窗状态 | 复现移除成功后界面仍显示旧状态。修复后按服务端返回的成员数据更新行状态，连续修改角色、恢复资格和移除均立即反映结果，后续操作保留已保存的新角色，提交期间控件禁用 |
| 修复回归 | npm run build 与既有 11 项服务端集成测试通过；数据库读回确认正常增量和两个图形保留，测试成员已停用 |

本次两项受阻步骤均已完成。撤权停止服务端访问，不能收回设备上已有的缓存或下载内容；本机数据保留符合 PRD。原始截图、会话与测试数据继续留在忽略目录，不公开提交。

仍待验收：会话自然到期、离线期间撤权和旧备份恢复的浏览器异常离线稿场景、远端光标与在线成员、本机保存失败注入、离线稿查看和恢复入口、原生附件全流程、正式容量及全部原生格式行为。当前仍未部署至目标 ECS。


## 会话过期、离线撤权与旧备份恢复 · 2026-10-12

继续使用独立 Google Chrome 和内置 Chromium，建立新的临时验证空间，直接操作原生编辑器，不修改浏览器身份或本机存储来伪造结果。下表补充此前待验的三类异常，并覆盖修复后的持续保护。

| 验证 | 结果与边界 |
|---|---|
| 会话过期 | Chrome 切换 Offline 并刷新，确认请求被网络面板阻断，新增正文仅本机保存。将服务端测试时钟推进 31 天，恢复网络后真实会话核验失败并暂停上传；恢复所有者和原编辑成员身份后，异常稿仍在本机且未出现在管理者文档。验证实际过期条件，未真实等待 30 天，也未验收 Cookie 自然清除 |
| 离线期间撤权 | Chrome 断网刷新后继续编辑，管理者移除该成员；重连被阻断。恢复资格并兑换原身份的新会话后，异常稿继续暂停，不自动进入管理者正文 |
| 暂停跨刷新和登录 | 修复前真实复现重新登录后自动回写；修复后恢复同一成员身份及重新打开文档，保留暂停原因和完整本机正文。授权版本的先变更后恢复另由自动化回归覆盖 |
| 明确隔离与导出 | 点击保留离线稿并读取云端后，当前文档显示云端版本，异常稿不上传。Chrome 实际下载的导出文件分别包含过期稿、撤权稿及隔离后的快照，读取错误为空 |
| 旧备份准备 | 在有效会话、活跃编辑成员和未兑换邀请均存在时创建真实备份；随后产生已保存的云端修改和离线修改，并移除成员。保留原目录，将旧备份恢复到新的空目录，再使用相同回环地址访问 |
| 恢复维护与凭据 | 恢复后空间代际改变、访问暂停、会话和邀请表为空、非所有者全部停用。真实浏览器确认旧恢复码失败，新恢复码轮换后进入维护；成员弹窗显示已移除，所有者核对后才恢复访问。旧邀请在解除维护后仍无效 |
| 旧代际不写回 | Chrome 旧会话重连暂停；所有者明确重新授权原成员后，Chrome 按新代际读回备份正文。备份后的云端增量和离线稿不进入恢复后的文档，导出文件同时保留两份旧代际缓存、两份新代际缓存及旧稿快照，读取错误为空 |
| 正常重连回归 | 在恢复后的新代际中再次断网、刷新、编辑并恢复网络，正常修改自动到达管理者端，显示云端保存；该回归没有点击手动重试 |
| 自动化和构建 | 21 项回归及构建通过，涵盖服务端保存、权限历史、真实 HTTP 过期到客户端持久暂停、IndexedDB 重开和版本 1 升级、旧稿隔离、旧代际正文附件保留、旧备份凭据失效及进程崩溃读回。fake-indexeddb 仅提供测试用 IndexedDB 实现，不能替代真实浏览器的落盘证据 |

仍待验收：远端光标和在线成员、本机保存失败注入、离线稿查看比较与人工合并、异常附件重新提交、原生附件全流程、正式容量及全部原生格式行为。此次恢复仅为回环临时环境，目标 ECS 恢复演练和实际部署尚未执行。原始截图、下载文件、恢复材料及各次测试目录不公开提交。
