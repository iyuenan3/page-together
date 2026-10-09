# ARCHITECTURE

## 已定结构

浏览器挂载 BlockSuite，Yjs 承载协同状态。应用服务负责空间、邀请、成员与权限，协同服务对连接和更新鉴权，持久化层管理正文、元数据和附件。

## 待验证

本地验证壳为 TypeScript、Lit 与 Vite 6.4.4；@blocksuite/affine 0.22.4、Yjs 13.6.33 通过完整 Store/View 扩展管理器挂载，保持正文与画板共用文档。具体能力与版本依据见 EDITOR_CAPABILITIES，取舍见 DECISIONS ADR-003。

src/lab 使用上游 test-only TestWorkspace、默认内存 Blob 源及空文档网络源。提供文档列表、模式服务、字体、主题、公式样式、引用跳转和原生辅助面板入口，不承担认证、持久化或跨浏览器通信。生产 Workspace/Doc 必须另实现。

发布包导出 TypeScript 源码。Vite 使用上游同类 WASM 与 vanilla-extract 插件，保留原生 effects。宿主类型检查通过 scripts/check-types.mjs 映射到同版本随包发布的声明文件，避免把第三方源码内部诊断混入宿主检查；运行构建仍使用原始源码。useDefineForClassFields 与上游保持 false，库类型支持 ESNext。

开发预构建排除原生源码包，保留 .css.ts 插件处理；通过 TypeScript AST 收集其外部运行入口，转换 CommonJS 与深层依赖；显式编译装饰器。实际接入事件见 MEMORY。

依赖审计发现旧传递依赖 KaTeX 与 Vitest 问题。锁定覆盖为 KaTeX 0.18.2、Vitest 4.1.11；实际构建和公式渲染分别验证，不能以审计零报告替代行为验收。React 18.3.1 仅用于满足上游图标模块 peer，宿主使用 Lit。构建保留第三方许可原文。

网络 provider、数据库、附件存储及单进程或分进程部署尚未选定。下一阶段验证生产文档接口、真实跨浏览器同步与持久化，依据资源和恢复结果确定实现。

## 禁改

不得以 Markdown 投影替代完整文档真相源。不得让客户端自行决定成员权限。重大取舍先记录 DECISIONS。
