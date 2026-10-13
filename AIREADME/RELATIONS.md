# RELATIONS

## 出向依赖

BlockSuite 官方编辑器与文档模型：https://github.com/toeverything/blocksuite 。
Yjs 官方 CRDT：https://github.com/yjs/yjs 。
PDF.js 官方本地渲染：https://github.com/mozilla/pdf.js/releases/tag/v6.4.299 ，固定 pdfjs-dist 6.4.299，阅读器和资源随应用打包，无外部转换服务。
fflate 官方 ZIP 读写：https://github.com/101arrowz/fflate ，从现有安装图显式固定 0.8.3；按实际解压字节限制迁移包，不信任声明大小。
画板字体沿用 BlockSuite 固定版本的 CommunityCanvasTextFonts，七种字体共 29 个资源由 fonts.cdnfonts.com 提供；首次联网读取成功后缓存在本机，不向字体源上传文档或附件。缓存与失败提示见 ADR-024。
数据视图已有图片 URL 由浏览器直接读取其资源源站，使用 no-referrer；不接入图片代理或外链缓存，重试不上传文档。展示、离线与视觉导出边界见 SPEC、ADR-027；浏览器行为依据 [HTML img 文档](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img)。
本地验证基线固定 BlockSuite 0.22.4、Yjs 13.6.33，具体依赖见 package.json 与 package-lock.json；许可见 THIRD_PARTY_NOTICES.md。生产版本在完整验收后确定。

## 入向依赖

个人主页负责公开项目展示。开发文档不依赖私人知识库或雇主项目。

## 共享底座

后续使用用户已指定的既有 ECS，并计划复用其共享 HTTPS 入口。目标环境已只读核验，部署状态与接入条件见 DEPLOYMENT。实际接入前核对属主配置与资源边界，不在公开仓复制服务器连接信息或现有项目秘密。
