import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 代码所在目录。public/、内置默认图标这些只读资源都在它下面。 */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 可写根目录 —— config.json 和运行数据（data/）落在哪儿。
 *
 * 平时就是 ROOT，和以前完全一样。但打包安装后代码可能落在**只读**位置
 * （Linux 的 /opt/ai-website、macOS 的 /usr/local/ai-website），往那儿写
 * config.json 会直接 EACCES 把程序打挂。所以安装包留了一个口子：
 * 启动脚本设 AI_WEBSITE_HOME，配置和 data/ 就跟着它走。
 * 注意 ROOT 依然是代码目录，两者不能混用。
 */
export const HOME = process.env.AI_WEBSITE_HOME
  ? path.resolve(process.env.AI_WEBSITE_HOME)
  : ROOT;

const CONFIG_FILE = path.join(HOME, 'config.json');

const CONFIG_DEFAULTS = {
  port: 3000,
  host: '0.0.0.0',
  adminInitialPassword: 'admin123',
  dataDir: './data',
  sessionTtlHours: 12,
};

export function loadConfig() {
  let raw = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      console.error(`[config] config.json 解析失败，将使用默认配置：${err.message}`);
    }
  } else {
    // HOME 可能是安装脚本刚建出来的（甚至还没建），先确保存在再写
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG_DEFAULTS, null, 2) + '\n');
    console.log(`[config] 已生成默认 config.json：${CONFIG_FILE}`);
  }

  const config = { ...CONFIG_DEFAULTS, ...raw };
  config.port = Number(config.port) || CONFIG_DEFAULTS.port;
  config.sessionTtlHours = Number(config.sessionTtlHours) || CONFIG_DEFAULTS.sessionTtlHours;
  config.dataDir = path.resolve(HOME, config.dataDir);
  return config;
}
