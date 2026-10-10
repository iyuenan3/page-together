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
