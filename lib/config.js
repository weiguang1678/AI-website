import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG_FILE = path.join(ROOT, 'config.json');

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
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG_DEFAULTS, null, 2) + '\n');
    console.log('[config] 已生成默认 config.json');
  }

  const config = { ...CONFIG_DEFAULTS, ...raw };
  config.port = Number(config.port) || CONFIG_DEFAULTS.port;
  config.sessionTtlHours = Number(config.sessionTtlHours) || CONFIG_DEFAULTS.sessionTtlHours;
  config.dataDir = path.resolve(ROOT, config.dataDir);
  return config;
}
