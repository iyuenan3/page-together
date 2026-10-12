# pageTogether

给自己和朋友的共享文档与画板空间。

Invite-only documents and whiteboards for friends, built with BlockSuite and Yjs. In development.

pageTogether 希望让受邀成员在浏览器里共同记录、整理和创作。文档与画板共享同一套内容，进入空间无需邮箱注册。

## 当前状态

项目已进入生产保存与同步基础实现阶段。当前代码提供 BlockSuite 原生编辑器、自主生产工作区、邀请与离线恢复码、空间三档权限、回收站、IndexedDB 本机保存、WebSocket 增量同步、SQLite 持久化，以及附件与备份恢复接口。

**基础实现已有测试，完整产品仍待验收，尚未部署。** 独立 Chrome 与内置 Chromium 已验证正文双向同步、画板图形交换、离线刷新与重连合并、在线降权、删除恢复后的新代际读取、服务重启读回和成员撤权。会话过期、离线期间撤权和旧备份恢复的异常稿保护已补验，过期场景通过推进服务端测试时钟触发。异常暂停会跨刷新及身份恢复保留，用户可保留旧稿并重新读取云端。

当前另已验证正文远端光标、画板指针与当前文档在线成员；同一成员的多个页面合并计数。真实 Chrome 配额故障下，保存失败提示持续保留，内存稿可导出，重试后完整同步。离线稿可使用原生正文和画板只读对照，提供文字差异辅助、确认后追加及原稿导出；追加前重新核验权限并保留合并前的当前文档。文字比较不包含图形和格式差异。

附件已通过独立浏览器上传下载、断网缓存下载、离线新增后刷新重连、权限变化后明确重新提交，以及旧备份恢复后的原文件保留与重新提交验证。本机附件落盘失败时可下载内存中的原文件并重试；上传期间的权限和文档状态变化由服务端重新核验。图片、音视频、PDF 和纯文本预览已有真实浏览器证据，并修复混合图片与文件 drop 漏项。系统文件拖入和剪贴板组合仍待人工补验。

50 项自动化测试、类型检查和构建通过。10 个独立成员会话同时在线编辑、50 MB 附件在线及断网下载摘要核对通过；另以预先固定的负载完成本机容量验证，见 [容量方案与结果](AIREADME/CAPACITY.md)。全部原生能力、长时间压力和目标 ECS 容量仍待验证，逐项证据见 [能力与验证记录](AIREADME/EDITOR_CAPABILITIES.md)。后续部署目标为 ECS，详见 [部署状态](AIREADME/DEPLOYMENT.md)。

![pageTogether 编辑器验证页中的原生画板、正文与公式](docs/images/editor-lab.jpg)

上图为真实编辑器验证页，使用合成内容。完整原生能力清单、已验证项目与待验收范围见 [编辑器能力清单](AIREADME/EDITOR_CAPABILITIES.md)。

## 产品方向

以下为已确认的产品目标，尚未全部实现：

- 通过邀请进入同一个共享空间，填写昵称参与，无需邮箱注册。
- 在原生正文与画板之间切换，共同编辑空间内的文档。
- 完整保留选定 BlockSuite 版本的原生编辑能力，并逐项验收。
- 采用空间级管理、编辑、查看三档权限；整篇文档仅管理者可删除和恢复，服务端负责鉴权、撤权、附件与资源限制。
- 支持已缓存文档的离线编辑，正常重连自动合并，异常时保留离线稿；实现持久化和可验证的备份恢复，所有者使用离线恢复码恢复访问。

初期按最多 10 人同时在线、单个附件 50 MB 设计与验证。具体需求和验收标准见 [PRD](AIREADME/PRD.md)。

## 附件与离线缓存

打开文档后使用“添加附件”，或沿用原生编辑器的附件入口。文件先保存到此设备，再按当前身份和文档状态上传；引用新附件的正文会等待附件保存确认。已缓存原文件可在“附件与离线缓存”中断网下载，未缓存文件需要联网。

该窗口提供缓存文件预览：图片、浏览器支持的音视频、PDF 和 UTF-8 文本。文本最多预览前 128 KiB，HTML 等内容按纯文本显示。PDF 和媒体编码依赖浏览器支持；Office 文档、压缩包、未知格式或损坏文件提供原文件下载。预览只读缓存，不修改正文；已缓存预览可断网使用。实际验证的格式和浏览器差异见能力记录。

网络和空间配额异常时保留原文件供重试。会话失效、权限变化或文档状态变化后，异常附件保持暂停；先恢复身份、处理旧正文并打开当前获准编辑的文档，再选择“确认重新提交到当前文档”。该操作追加新的附件卡片，同时保留原文件副本。备份恢复前的附件也可按此方式处理，旧正文不会随附件重新提交自动写回。

本机保存失败时保留页面，可下载内存原文件并重试本机保存。若文件尚未成功添加到正文，落盘后会提示明确重新提交。首版不自动清理离线附件及原始副本。

## 本地开发

使用 Node.js 22，版本至少为 22.12.0。在仓库根目录运行：

```sh
npm ci --ignore-scripts
npm rebuild better-sqlite3
npm run build
PAGETOGETHER_DATA_DIR=.local/dev-data npm run server:admin -- init '本机测试所有者'
PAGETOGETHER_DATA_DIR=.local/dev-data PAGETOGETHER_ORIGIN=http://127.0.0.1:3000 npm run server
```

打开 `http://127.0.0.1:3000`，使用初始化输出的恢复码进入，并离线保存轮换后的新码。初始化只对新数据目录执行一次；恢复材料不写入仓库或日志。数据和验证产物在忽略目录中，服务仅监听回环地址，按 `Ctrl+C` 停止。这是临时开发验证方式，尚无已部署的服务。

使用热更新时，另启 `npm run dev`，把后台的 `PAGETOGETHER_ORIGIN` 设为 `http://127.0.0.1:5173`；Vite 将 `/api` 代理到本机后台。`/lab.html` 保留独立内存验证页，刷新会重置。离线重开需使用已缓存的构建产物。

| 命令 | 用途 |
|---|---|
| `npm run check` | 检查宿主代码与上游发布声明的类型兼容性 |
| `npm run build` | 类型检查、前后端构建、离线资源缓存与第三方许可清单 |
| `npm test` | 保存确认、权限、备份恢复、离线暂停、远端状态、附件及本机存储故障回归 |
| `npm run test:capacity` | 新建隔离数据，验证 10 人、40 条文档连接、50 MB 附件与备份恢复；方案和边界见 CAPACITY |
| `npm run dev` | 本机热更新开发，需另启后台 |
| `npm run server` | 运行构建后的完整服务，必须配置 Origin |
| `npm run server:admin -- backup .local/new-backup` | 备份到尚不存在的目录 |
| `PAGETOGETHER_DATA_DIR=.local/restored npm run server:admin -- restore .local/new-backup` | 恢复到全新目录，默认暂停访问并轮换凭据 |

当前基线固定为 BlockSuite 0.22.4、Yjs 13.6.33，宿主使用 TypeScript、Lit 与 Vite。后台为 Node.js 22、better-sqlite3 13.0.3 和 ws 8.22.0，首版单实例、本机可靠磁盘保存；数据库提交不等于异机备份完成。`TestWorkspace` 仅用于验证页，技术边界和当前限制见 [ARCHITECTURE](AIREADME/ARCHITECTURE.md)，实际接口和保护限额见 [SPEC](AIREADME/SPEC.md)。

## 文档

- [产品需求与验收标准](AIREADME/PRD.md)
- [编辑器完整能力与验证记录](AIREADME/EDITOR_CAPABILITIES.md)
- [容量方案、复现与结果](AIREADME/CAPACITY.md)
- [下一步计划](AIREADME/ROADMAP.md)
- [项目文档索引](AIREADME/INDEX.md)
- [开发约定](AGENTS.md)

## 上游与许可

- [BlockSuite](https://github.com/toeverything/blocksuite/tree/v0.22.4) 提供原生编辑器与文档模型。
- [Yjs](https://github.com/yjs/yjs) 提供 CRDT 数据结构。

项目自主代码采用 [MIT](LICENSE)。上游与第三方组件保留各自许可，具体声明见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。

`npm run build` 会生成 `dist/THIRD_PARTY_LICENSES.txt`，分发构建产物时一并保留。
