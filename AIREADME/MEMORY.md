# MEMORY

尚无本项目运行事故。后续只追加已实际发生并有证据的现象、根因、结论与预防，不将预期风险冒充已踩坑。

## 2026-10-09 · 发布源码包的开发模式接入

现象：生产构建预览能渲染，但开发页面空白。先出现装饰器 SyntaxError，随后出现 vanilla-extract file scope 错误和 CommonJS 导出缺失。

根因：BlockSuite 0.22.4 包直接导出 TypeScript 源码。vite-plugin-wasm 3.6.0 在 configResolved 将依赖预构建目标设为 esnext，普通 target 设置会被覆盖。预构建原生包还绕过 Vite 的 .css.ts 处理；排除源码包后，其外部运行依赖和深层导入需要明确预构建。

结论：显式设置 optimizer 的 supported.decorators=false；将导出源码的 BlockSuite 包排除，仍交由 Vite 样式插件处理；用 TypeScript AST 收集实际 import、export 和动态 import，跳过纯类型与 JSON 资产，将外部运行入口交给 optimizer。已在真实开发浏览器回读正文渲染。

预防：同时验证 npm run dev 和 npm run build 后的预览；构建成功不能代替开发页面实际加载。生成类型配置内容未变化时不改写，避免触发开发服务器无效重载。
