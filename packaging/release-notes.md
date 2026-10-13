带秘钥验证的 AI 问答网站 —— 前端 + 管理后台。**每个安装包都自带一份官方 Node 运行时**，
装完就能跑，不需要你自己装 Node.js。

## 挑哪个下载

| 你的系统 | 下载 | 怎么装 |
| --- | --- | --- |
| Windows 10/11 | `AI-Website-Setup-<版本>.exe` | 双击。装到 `%LOCALAPPDATA%\AI 网站`，自动建开始菜单和桌面快捷方式，卸载在「设置 → 应用 → 已安装的应用」里 |
| Windows（免安装） | `AI-Website-<版本>-win-x64.zip` | 解压到任意目录，双击里面的 `启动网站.cmd` |
| macOS（Apple 芯片） | `AI-Website-<版本>-macos-arm64.pkg` | `sudo installer -pkg ... -target /`，装到 `/usr/local/ai-website` |
| macOS（Intel） | `AI-Website-<版本>-macos-x64.pkg` | 同上 |
| macOS（免安装） | `AI-Website-<版本>-macos-arm64.tar.gz` | 解压后双击 `启动网站.command` |
| Debian / Ubuntu | `AI-Website-<版本>-linux-x64.deb` | `sudo dpkg -i ...`，装到 `/opt/ai-website`，应用菜单里会出现「AI 网站」 |
| 其他 Linux | `AI-Website-<版本>-linux-x64.tar.gz` | 解压后跑 `./ai-website` |

`SHA256SUMS.txt` 是所有产物的校验和，下载完可以核对一下。

## 装完怎么用

1. 启动后它自己会开浏览器，地址是 `http://127.0.0.1:3000`。
2. **初始后台密码是 `admin123`** —— 打开后台第一件事就是去「入口与安全」里改掉。
3. 后台地址默认是 `/admin`，可以在设置里改成别的（改完老地址对外就是 404 了，
   但本机仍然进得去，忘了新地址也不会把自己锁在外面）。
4. API Key 填在后台的「AI 设置」里。**Key 只存在你自己机器的 `db.json` 里**，
   不会发给浏览器，也不会发给除了你自己配置的那个 AI 接口以外的任何地方。

## 几点需要知道的

- **这些包都没有代码签名。** 所以：
  - Windows 上第一次运行会弹 SmartScreen 的「Windows 已保护你的电脑」——
    点「更多信息 → 仍要运行」即可；想确认没被换过就对一下 `SHA256SUMS.txt`。
  - macOS 上 .pkg 会被 Gatekeeper 拦（「无法验证开发者」）——
    右键点安装包选「打开」，或者用上面的 `installer` 命令。
- 程序**不装系统服务、不设开机自启、不改系统设置**。想彻底删干净：
  - Windows：从「设置 → 应用」里卸载（会清掉程序目录、两个快捷方式和卸载项）。
  - Debian / Ubuntu：`sudo dpkg -r ai-website`
  - macOS：`.pkg` 没有自带的卸载器，手动删 ——
    `sudo rm -rf /usr/local/ai-website /usr/local/bin/ai-website`
  - 上面三步都不会动你的数据。设置、API Key 和聊天记录在
    `~/.ai-website`（Windows 装在 `%LOCALAPPDATA%\AI 网站`），
    要一起删掉得自己删这个目录 —— 但删了就找不回来了。
- 想发布到公网需要自己再配一条 Cloudflare 隧道（`cloudflared`），安装包里不含这一步。
- 默认只监听 `127.0.0.1`，同一局域网的其他设备默认是访问不到的。想开给局域网，
  改配置文件里的 `host`（Windows 装在 `%LOCALAPPDATA%\AI 网站\config.json`，
  macOS/Linux 在 `~/.ai-website/config.json`）。
