#!/usr/bin/env node
/**
 * gavel CLI 启动器。
 *
 * 优先加载构建产物 lib/（任何受支持的 Node 版本均可运行）；
 * 若尚未构建，则回退到直接运行 src/ 下的 TypeScript 源码
 * （需要 Node >= 23.6，利用内置类型擦除能力）。
 */
const here = import.meta.url;

async function boot() {
  const lib = new URL('../lib/cli.js', here);
  try {
    return await import(lib.href);
  } catch (libError) {
    try {
      const src = new URL('../src/cli.ts', here);
      return await import(src.href);
    } catch {
      const message = libError instanceof Error ? libError.message : String(libError);
      console.error(
        `gavel: 加载失败：${message}\n` +
          '（若未构建，请先执行 npm run build；源码直跑需要 Node >= 23.6）',
      );
      process.exitCode = 1;
      return null;
    }
  }
}

const mod = await boot();
if (mod && typeof mod.main === 'function') {
  process.exitCode = await mod.main(process.argv.slice(2));
} else if (mod) {
  console.error('gavel: 入口模块缺少 main 导出，请先执行 npm run build');
  process.exitCode = 1;
}
