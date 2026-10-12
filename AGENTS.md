# AGENTS.md · pageTogether

## 当前阶段

当前已有 src/app 生产工作区、server 保存与鉴权基础、shared 同步协议，以及 src/lab 原生编辑器内存验证壳。TestWorkspace 仅供验证，不得用于生产保存层。基础实现与已验证路径见 SPEC、CHANGELOG，完整产品仍待分阶段验收。

产品需求已收敛，具体确认项与验收标准见 [PRD](AIREADME/PRD.md) 和 [DECISIONS](AIREADME/DECISIONS.md)。本机预览已停止，后续部署目标为既有 ECS，实际部署按用户指令执行。以真实 Git、代码与运行证据核对文档状态。

## 启动顺序

1. 读 AIREADME/INDEX.md。
2. 按任务路由读取对应文档。
3. 核对 Git 和当前文件状态，保留既有改动；沿用 PRD 与决策记录中已确认的需求，不重复询问。
4. 实施前核对上游官方文档和选定版本，记录兼容关系。版本升级单独评估，不混装不同代包。

## 路由

- 接手与产品边界：[CORE](AIREADME/CORE.md)、[PRD](AIREADME/PRD.md)、[ROADMAP](AIREADME/ROADMAP.md)。
- 编辑器接入：[ARCHITECTURE](AIREADME/ARCHITECTURE.md)、[EDITOR_CAPABILITIES](AIREADME/EDITOR_CAPABILITIES.md)、[CONVENTIONS](AIREADME/CONVENTIONS.md)。
- 权限、身份、离线重连与保存：[PRD](AIREADME/PRD.md)、[ARCHITECTURE](AIREADME/ARCHITECTURE.md)、[SPEC](AIREADME/SPEC.md)。
- 容量与资源限额：[CAPACITY](AIREADME/CAPACITY.md)、[SPEC](AIREADME/SPEC.md)。
- 重大取舍与排坑：[DECISIONS](AIREADME/DECISIONS.md)、[MEMORY](AIREADME/MEMORY.md)。
- 部署与外部关系：[DEPLOYMENT](AIREADME/DEPLOYMENT.md)、[RELATIONS](AIREADME/RELATIONS.md)。
- 里程碑与已有证据：[CHANGELOG](AIREADME/CHANGELOG.md)、[EDITOR_CAPABILITIES](AIREADME/EDITOR_CAPABILITIES.md)。

## 红线

- 完整保留选定 BlockSuite 版本的原生编辑能力，不擅自缩为纯文本编辑器。
- 昵称只是显示信息，不能作为认证凭据或用户唯一标识。
- 共享空间不代表匿名公开，HTTP、WebSocket、附件均需服务端鉴权。
- 撤权需终止既有访问，不能只隐藏前端按钮。
- 离线修改须遵守重连时的当前授权和文档生命周期，不得自动复活已删除文档。
- 未通过数据保存和恢复验证，不得宣称协同产品可用。
- 只从公开上游独立实现，禁止导入任何雇主代码、内部文档、测试数据或专有素材。
- 公开文件禁止凭证、邀请值、会话值、私人绝对路径与服务器连接细节。
- 保留用户改动与历史，禁止删除历史、rebase 或 force-push。
- 不生成虚构部署配置，不将环境核验快照写成当前上线状态。
- 中文产出不用破折号。日期按 Asia/Shanghai，星期通过工具验证。

## 文档责任

- 产品变化更新 PRD，硬约束更新 CORE。
- 组件变化更新 ARCHITECTURE，外部契约变化更新 SPEC。
- 决策追加 DECISIONS，真实事故追加 MEMORY，里程碑追加 CHANGELOG。
- DECISIONS、MEMORY、CHANGELOG 保留既有条目，用新条目说明后续变化。
- 部署后填 DEPLOYMENT，不将规划写成上线。
- AIREADME 同步锚点使用最后审阅的内容提交，文档提交独立进行。
- AGENTS 保持路由与护栏，不复制 PRD 的完整权限矩阵或架构实现细节。

## 验证

类型检查 npm run check；构建 npm run build；保存、权限与恢复集成测试 npm test。服务命令和初始化见 README；本机仅作临时回环验证，完成后停止服务。原生内存验证页为 /lab.html。

独立容量验证 npm run test:capacity，负载与阈值先固定，服务资源在独立子进程测量，结果边界见 CAPACITY。本机短时通过不能替代 ECS、广域网、长时间压力或全部原生能力验收。

完整原生能力与逐项证据见 [EDITOR_CAPABILITIES](AIREADME/EDITOR_CAPABILITIES.md)，权限、离线与恢复验收见 [PRD](AIREADME/PRD.md)。分别报告类型检查、构建、浏览器操作、服务端保存和实际部署，未执行的项目保持待验收。

文档更新后运行 aireadme 技能的结构与漂移检查，并检查本地链接、公开边界和历史追加；这些检查不能替代产品验收。
