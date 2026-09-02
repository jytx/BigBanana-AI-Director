/**
 * 服务端代码受保护构建脚本
 *
 * 流程：esbuild 将各服务入口打包为单文件 CJS →
 * javascript-obfuscator 混淆 → 输出到 server/protected/*.cjs。
 * Dockerfile.cutos-api 会执行本脚本并仅拷贝 protected 产物进镜像。
 *
 * 依据 3.4.1 镜像内产物结构（protected/*.cjs + 混淆特征）恢复编写。
 */
import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 读取 package.json 中的依赖包名作为 external：
 * npm 包由运行环境的 node_modules 提供，只打包项目自身源码
 * （与官方镜像行为一致：产物仅百余 KB，node_modules 完整存在）
 */
const readExternalPackages = () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  return Object.keys(packageJson.dependencies || {});
};

/** 服务入口 → protected 产物名的映射 */
const SERVER_ENTRIES = [
  { entry: 'server/mediaProxyServer.mjs', output: 'media-proxy.cjs' },
  { entry: 'server/newApiProxyServer.mjs', output: 'new-api-proxy.cjs' },
  { entry: 'server/cutosApiServer.mjs', output: 'cutos-api.cjs' },
];

/** 产物输出目录（与镜像内 /app/protected 保持一致） */
const OUTPUT_DIR = path.resolve(process.cwd(), 'server', 'protected');

/** 混淆配置：字符串数组 + 控制流扁平化，兼顾保护强度与运行性能 */
const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  selfDefending: false,
};

/**
 * 构建单个服务：打包 → 混淆 → 落盘
 * @param {{ entry: string, output: string }} task - 构建任务
 * @param {string[]} externalPackages - 不参与打包的 npm 包名
 * @returns {Promise<void>}
 */
const buildServerEntry = async ({ entry, output }, externalPackages) => {
  const bundle = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    external: externalPackages,
  });

  const bundledCode = bundle.outputFiles[0].text;
  const obfuscated = JavaScriptObfuscator.obfuscate(bundledCode, OBFUSCATOR_OPTIONS).getObfuscatedCode();

  const outputPath = path.join(OUTPUT_DIR, output);
  await fs.promises.writeFile(outputPath, obfuscated, 'utf8');
  console.log(`[build-obfuscated-server] ${entry} -> ${outputPath}`);
};

const main = async () => {
  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });
  const externalPackages = readExternalPackages();
  for (const task of SERVER_ENTRIES) {
    await buildServerEntry(task, externalPackages);
  }
  console.log(`[build-obfuscated-server] 完成，共 ${SERVER_ENTRIES.length} 个服务`);
};

main().catch((error) => {
  console.error('[build-obfuscated-server] 构建失败:', error);
  process.exit(1);
});
