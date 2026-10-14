# RELATIONS

## 出向依赖

BlockSuite 官方编辑器与文档模型：https://github.com/toeverything/blocksuite 。
Yjs 官方 CRDT：https://github.com/yjs/yjs 。
PDF.js 官方本地渲染：https://github.com/mozilla/pdf.js/releases/tag/v6.4.299 ，固定 pdfjs-dist 6.4.299，阅读器和资源随应用打包，无外部转换服务。
fflate 官方 ZIP 读写：https://github.com/101arrowz/fflate ，从现有安装图显式固定 0.8.3；按实际解压字节限制迁移包，不信任声明大小。
画板字体沿用 BlockSuite 固定版本的 CommunityCanvasTextFonts，七种字体共 29 个资源由 fonts.cdnfonts.com 提供；首次联网读取成功后缓存在本机，不向字体源上传文档或附件。缓存与失败提示见 ADR-024。
汉字补充字体取自官方 [BabelStone Han](https://babelstone.co.uk/Fonts/Han.html) 16.0.3，固定源摘要并以 fonttools[woff] 4.60.1 提取 32,993 个补充平面映射。修改名为 pageTogether Han Supplement，原始 [Arphic Public License](../public/assets/HAN-LICENSE.txt)、版权和 [覆盖清单](../public/assets/han-coverage.json) 保留，约 4.83 MB WOFF2 随应用同源分发和预缓存。再生成脚本只在维护时使用，不新增运行时外部字体请求，见 ADR-032。
数据视图已有图片 URL 由浏览器直接读取其资源源站，使用 no-referrer；不接入图片代理或外链缓存，重试不上传文档。展示、离线与视觉导出边界见 SPEC、ADR-027；浏览器行为依据 [HTML img 文档](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/img)。
视觉导出继续使用固定上游的 html2canvas 1.4.1 与 pdf-lib，关闭原生默认的公共图片代理，外链直接遵守浏览器 CORS，不新增服务端抓取。克隆图片比例与现代颜色兼容处理见 ADR-028；上游实现依据 [html2canvas 1.4.1](https://github.com/niklasvh/html2canvas/tree/v1.4.1)，已知样式扩展标记依据 [Dark Reader 注入源码](https://github.com/darkreader/darkreader/blob/main/src/inject/dynamic-theme/index.ts)。没有升级依赖或引入新的外部服务。
本地验证基线固定 BlockSuite 0.22.4、Yjs 13.6.33，具体依赖见 package.json 与 package-lock.json；许可见 THIRD_PARTY_NOTICES.md。生产版本在完整验收后确定。

## 入向依赖

个人主页负责公开项目展示。开发文档不依赖私人知识库或雇主项目。

## 共享底座

后续使用用户已指定的既有 ECS，并计划复用其共享 HTTPS 入口。目标环境已只读核验，部署状态与接入条件见 DEPLOYMENT。实际接入前核对属主配置与资源边界，不在公开仓复制服务器连接信息或现有项目秘密。
