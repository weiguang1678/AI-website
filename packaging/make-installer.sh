#!/usr/bin/env bash
#
# 把 build.mjs 打出来的便携包，再包一层各平台自己的安装包：
#
#   macOS   → .pkg   装到 /usr/local/ai-website，另外给一个 /usr/local/bin/ai-website
#   Linux   → .deb   装到 /opt/ai-website，带 .desktop，应用菜单里能点开
#   Windows → 不用管 —— .exe 安装包由 build.mjs 用自带的 csc.exe 直接编出来
#
# 用法（在项目根目录跑）：
#   bash packaging/make-installer.sh mac-arm64 dist
#   bash packaging/make-installer.sh linux-x64  dist
#
# **这两个包只能在各自的系统上做**：pkgbuild 是 macOS 的、dpkg-deb 是 Debian 系的，
# 两个都不跨平台。所以实际调用方是 CI 的对应 runner，在 Windows 开发机上跑
# 只会有 win-* 那条分支被走到（直接跳过）。
set -euo pipefail

target="${1:?用法: make-installer.sh <win-x64|mac-x64|mac-arm64|linux-x64> [输出目录]}"
out="${2:-dist}"

cd "$(dirname "$0")/.." # 回到项目根

# 不从 package.json 里 require 版本号：这个包是 ESM（"type": "module"），
# `node -p "require(...)"` 在不同 Node 版本上行为不一样，读一行文本最稳。
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)
[ -n "$version" ] || { echo "读不出 package.json 里的 version" >&2; exit 1; }
base="AI-Website-$version"

case "$target" in
  # ---------------------------------------------------------------- macOS
  mac-*)
    arch="${target#mac-}" # arm64 / x64
    stage="$out/stage/AI Website"
    [ -d "$stage" ] || { echo "找不到 $stage，先跑 build.mjs --target $target" >&2; exit 1; }

    scripts=$(mktemp -d)
    trap 'rm -rf "$scripts"' EXIT
    cat > "$scripts/postinstall" <<'POSTINSTALL'
#!/bin/sh
# 装完顺手给个命令行入口。
#
# 故意写成一个「转发脚本」而不是软链接：启动脚本里有 cd "$(dirname "$0")"，
# 软链接会让它解析到 /usr/local/bin，然后 ./runtime/node 就找不着了。
set -e
mkdir -p /usr/local/bin
cat > /usr/local/bin/ai-website <<'WRAP'
#!/bin/sh
exec "/usr/local/ai-website/启动网站.command" "$@"
WRAP
chmod 755 /usr/local/bin/ai-website
exit 0
POSTINSTALL
    chmod 755 "$scripts/postinstall"

    pkg="$out/$base-macos-$arch.pkg"
    rm -f "$pkg"
    # --install-location 就是普通用户的程序目录；那个目录是 root 的、写不进去，
    # 所以 start.mjs 会把 config.json 和 data/ 落到 ~/.ai-website 去（见 lib/config.js 的 HOME）。
    pkgbuild \
      --root "$stage" \
      --identifier com.aiwebsite.desktop \
      --version "$version" \
      --install-location /usr/local/ai-website \
      --scripts "$scripts" \
      "$pkg"
    echo "打好了：$pkg"
    ;;

  # ---------------------------------------------------------------- Linux
  linux-*)
    arch="${target#linux-}" # x64
    case "$arch" in
      x64) debarch=amd64 ;;
      arm64) debarch=arm64 ;;
      *) debarch="$arch" ;;
    esac

    stage="$out/stage/ai-website"
    [ -d "$stage" ] || { echo "找不到 $stage，先跑 build.mjs --target $target" >&2; exit 1; }

    root="$out/deb"
    rm -rf "$root"
    mkdir -p "$root/DEBIAN" "$root/opt" "$root/usr/bin" \
      "$root/usr/share/applications" "$root/usr/share/icons/hicolor/512x512/apps"

    cp -r "$stage" "$root/opt/ai-website"
    chmod 755 "$root/opt/ai-website/ai-website" "$root/opt/ai-website/runtime/node"
    cp public/assets/icon-default.png "$root/usr/share/icons/hicolor/512x512/apps/ai-website.png"

    # 同上：转发脚本，不能是软链接
    printf '#!/bin/sh\n# 转发到真正的启动脚本。别改成软链接：启动脚本用 dirname "$0" 定位自己，\n# 软链接会让它解析到 /usr/bin，然后找不到 runtime/node。\nexec /opt/ai-website/ai-website "$@"\n' \
      > "$root/usr/bin/ai-website"
    chmod 755 "$root/usr/bin/ai-website"

    cat > "$root/usr/share/applications/ai-website.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=AI 网站
Comment=带秘钥验证的 AI 问答网站
Exec=/opt/ai-website/ai-website
Icon=ai-website
Terminal=true
Categories=Network;Chat;Utility;
Keywords=AI;chat;问答;
DESKTOP
    chmod 644 "$root/usr/share/applications/ai-website.desktop"

    size=$(du -sk "$root/opt" | cut -f1)
    cat > "$root/DEBIAN/control" <<CONTROL
Package: ai-website
Version: $version
Architecture: $debarch
Maintainer: weiguang1678 <weiguang1678@users.noreply.github.com>
Section: web
Priority: optional
Installed-Size: $size
Description: AI 问答网站（自带 Node 运行时）
 带秘钥验证的 AI 问答前端 + 管理后台，内置一份官方 Node 运行时，
 装完就能用，不需要用户另外装 Node。
CONTROL

    deb="$out/$base-linux-$arch.deb"
    rm -f "$deb"
    dpkg-deb --build --root-owner-group "$root" "$deb"
    echo "打好了：$deb"
    ;;

  # ---------------------------------------------------------------- Windows
  win-*)
    echo "Windows 的 .exe 安装包由 build.mjs 直接产出，这里没有要做的"
    ;;

  *)
    echo "不认识的 target：$target" >&2
    exit 1
    ;;
esac
