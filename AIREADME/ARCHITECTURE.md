# ARCHITECTURE

## 目标组件与数据流

浏览器挂载 BlockSuite，Yjs 承载协同状态。应用服务负责空间、邀请、成员与权限，协同服务对连接和更新鉴权，持久化层管理正文、元数据和附件。这是待实现的职责划分，不预设必须拆成独立进程。

## 当前实现

本地验证壳为 TypeScript、Lit 与 Vite 6.4.4；@blocksuite/affine 0.22.4、Yjs 13.6.33 通过完整 Store/View 扩展管理器挂载，保持正文与画板共用文档。具体能力与版本依据见 EDITOR_CAPABILITIES，取舍见 DECISIONS ADR-003。

src/lab 使用上游 test-only TestWorkspace、默认内存 Blob 源及空文档网络源。提供文档列表、模式服务、字体、主题、公式样式、引用跳转和原生辅助面板入口，不承担认证、持久化或跨浏览器通信。生产 Workspace/Doc 必须另实现。

发布包导出 TypeScript 源码。Vite 使用上游同类 WASM 与 vanilla-extract 插件，保留原生 effects。宿主类型检查通过 scripts/check-types.mjs 映射到同版本随包发布的声明文件，避免把第三方源码内部诊断混入宿主检查；运行构建仍使用原始源码。useDefineForClassFields 与上游保持 false，库类型支持 ESNext。

开发预构建排除原生源码包，保留 .css.ts 插件处理；通过 TypeScript AST 收集其外部运行入口，转换 CommonJS 与深层依赖；显式编译装饰器。实际接入事件见 MEMORY。

依赖审计发现旧传递依赖 KaTeX 与 Vitest 问题。锁定覆盖为 KaTeX 0.18.2、Vitest 4.1.11；实际构建和公式渲染分别验证，不能以审计零报告替代行为验收。React 18.3.1 仅用于满足上游图标模块 peer，宿主使用 Lit。构建保留第三方许可原文。

## 生产接入边界（待实现）

浏览器本机持久层需要保存文档更新、未上传附件和重连前离线稿。离线重开还需要缓存应用及必要编辑器资源，仅保存文档数据不能保证页面可离线加载。实现依据见 [Yjs 离线支持](https://docs.yjs.dev/getting-started/allowing-offline-editing)。

重连数据流为本机草稿准备、当前身份和文档状态核验、获准的 Yjs 更新交换、服务端持久化及保存确认。文档增量同步依据公开 [Yjs 更新接口](https://docs.yjs.dev/api/document-updates)；正常合并与异常保留行为以 PRD 为准。

HTTP、WebSocket 与附件访问共用权威成员和权限状态，成员角色及文档生命周期由服务端控制。查看连接只接收获准内容，客户端提交的协同数据不能自行修改授权。删除、撤权与备份恢复需要阻断旧连接和旧离线稿自动写回。

正文、元数据与附件建立一致的保存和恢复边界，由持久化层提供保存确认；同步事件不能直接解释为持久化完成。备份同时覆盖身份与权限状态，具体恢复验收见 PRD。

网络 provider、本机持久化适配、数据库、附件存储及单进程或分进程部署尚未选定。现有 src/lab 不提供这些生产能力。

## 禁改

不得以 Markdown 投影替代完整文档真相源。不得让客户端自行决定成员权限。重大取舍先记录 DECISIONS。
