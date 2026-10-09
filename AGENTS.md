# AGENTS.md · pageTogether

## 当前阶段

项目已进入本地编辑器验证，有 src/lab、精确依赖与锁文件。TestWorkspace 仅供验证，不得用于生产保存层。以 README 的状态和真实 Git、代码、运行结果为准。

## 启动顺序

1. 读 AIREADME/INDEX.md。
2. 按任务路由读取对应文档。
3. 实施前核对上游官方文档和选定版本，记录兼容关系。

## 路由

- 产品范围：AIREADME/CORE.md、PRD.md。
- 编辑器接入：AIREADME/ARCHITECTURE.md、SPEC.md、CONVENTIONS.md。
- 重大取舍：AIREADME/DECISIONS.md。
- 部署：AIREADME/DEPLOYMENT.md、RELATIONS.md。
- 接手和下一步：AIREADME/ROADMAP.md、CHANGELOG.md。

## 红线

- 完整保留选定 BlockSuite 版本的原生编辑能力，不擅自缩为纯文本编辑器。
- 昵称只是显示信息，不能作为认证凭据或用户唯一标识。
- 共享空间不代表匿名公开，HTTP、WebSocket、附件均需服务端鉴权。
- 撤权需终止既有访问，不能只隐藏前端按钮。
- 未通过数据保存和恢复验证，不得宣称协同产品可用。
- 只从公开上游独立实现，禁止导入任何雇主代码、内部文档、测试数据或专有素材。
- 公开文件禁止凭证、邀请值、会话值、私人绝对路径与服务器连接细节。
- 保留用户改动与历史，禁止删除历史、rebase 或 force-push。
- 立项阶段不生成虚构部署配置，实际部署另行按用户指令执行。
- 中文产出不用破折号。日期按 Asia/Shanghai，星期通过工具验证。

## 文档责任

- 产品变化更新 PRD，硬约束更新 CORE。
- 组件变化更新 ARCHITECTURE，外部契约变化更新 SPEC。
- 决策追加 DECISIONS，真实事故追加 MEMORY，里程碑追加 CHANGELOG。
- 部署后填 DEPLOYMENT，不将规划写成上线。
- AIREADME 同步锚点使用最后审阅的内容提交，文档提交独立进行。

## 验证

本地验证使用 npm run dev；类型检查 npm run check；构建 npm run build；构建预览 npm run preview。完整能力清单与真实验证边界见 AIREADME/EDITOR_CAPABILITIES.md，不编造运行结果。
优先验证跨浏览器同步、断线恢复、重启保存、附件权限、撤权与资源限制。
