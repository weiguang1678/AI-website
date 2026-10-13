/*
 * Windows 安装包本体（双击运行的那个 .exe）。
 *
 * 它做的事，按顺序：
 *   1. 把编译时就嵌进来的 payload.zip 展开到 %LOCALAPPDATA%\AI Website；
 *   2. 在开始菜单和桌面各建一个快捷方式；
 *   3. 往注册表写一条卸载项，让它出现在「应用和功能」里；
 *   4. 启动网站（开一个自己的窗口），安装程序这个窗口随即结束。
 *
 * 为什么用 C# —— 因为编译它不需要下载任何东西：Windows 自带 .NET Framework
 * 的 csc.exe 就能编译这个文件（见 packaging/build.mjs 里那条 csc 命令）。
 *
 * 之前试过 Windows 自带的 IExpress，它在没有交互桌面的环境里会弹一个模态框
 * 卡死（本机实测如此，GitHub Actions 上更不可能通过），所以弃用。
 *
 * 编译要求：/codepage:65001（本文件是 UTF-8），/resource:payload.zip,payload.zip。
 * 语法只用到 C# 5 —— 那个自带的 csc.exe 就是 C# 5 级别，别写新语法，
 * 否则会以「CS1002: 应输入 ;」这种看不懂的报错炸在构建里。
 */
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using Microsoft.Win32;

internal static class Setup
{
    /** build.mjs 编译前会把这里替换成 package.json 里的版本号 */
    private const string Version = "__VERSION__";

    private const string PayloadResource = "payload.zip";
    private const string AppTitle = "AI 网站";
    private const string LaunchScript = "启动网站.cmd";
    private const string UninstallScript = "卸载.cmd";
    private const string PsUninstallScript = "uninstall.ps1";
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AI Website";

    private static string target;

    private static int Main()
    {
        // 控制台默认按系统 OEM 代码页（中文系统是 GBK）解析输出，下面全是中文，
        // 不切到 UTF-8 就是一堆乱码。切不了也不致命，照常继续。
        try { Console.OutputEncoding = Encoding.UTF8; } catch { /* 输出被重定向时可能不允许 */ }

        Console.WriteLine();
        Console.WriteLine("  AI 问答网站 · 安装程序 " + Version);
        Console.WriteLine("  ─────────────────────────────────────────────");

        try
        {
            target = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "AI 网站");

            Console.WriteLine("  安装到  " + target);
            Console.WriteLine();

            Console.WriteLine("  [1/4] 展开程序文件…");
            Directory.CreateDirectory(target);
            Unpack();

            Console.WriteLine("  [2/4] 创建快捷方式…");
            string launch = Path.Combine(target, LaunchScript);
            MakeShortcut(Path.Combine(Environment.GetFolderPath(
                Environment.SpecialFolder.DesktopDirectory), AppTitle + ".lnk"), launch);
            MakeShortcut(Path.Combine(Environment.GetFolderPath(
                Environment.SpecialFolder.Programs), AppTitle + ".lnk"), launch);

            Console.WriteLine("  [3/4] 写入卸载入口…");
            WriteUninstaller();
            RegisterUninstaller();

            Console.WriteLine("  [4/4] 启动网站…");
            Console.WriteLine();
            Console.WriteLine("  ─────────────────────────────────────────────");
            Console.WriteLine("  装好了。");
            Console.WriteLine("  以后从「开始菜单 → " + AppTitle + "」或桌面快捷方式启动；");
            Console.WriteLine("  不想用了就在「设置 → 应用 → 已安装的应用」里卸载。");
            Console.WriteLine();
            Console.WriteLine("  网站会在**另一个窗口**里跑起来，这个安装窗口可以直接关掉。");
            Console.WriteLine("  ─────────────────────────────────────────────");

            Process.Start(new ProcessStartInfo
            {
                FileName = launch,
                WorkingDirectory = target,
                UseShellExecute = true, // 让 .cmd 自己开一个控制台窗口，网站就住在那里
            });
            return 0;
        }
        catch (Exception ex)
        {
            Console.WriteLine();
            Console.WriteLine("  ✗ 安装失败：" + ex.Message);
            Console.WriteLine();
            Console.WriteLine("    什么也没装上。把上面这段截图发出去，通常一眼就能看出问题。");
            Console.WriteLine();
            PauseIfInteractive();
            return 1;
        }
    }

    // ------------------------------------------------------------------ 展开

    /**
     * 把嵌在 exe 里的 payload.zip 解到 target。
     *
     * zip 里所有条目都在同一个顶层目录下（「AI 网站/…」），这里先认出这个前缀
     * 再剥掉，这样打包脚本就能直接把便携版那个 zip 拿来用，不用再打一份。
     *
     * **重复安装不能把用户的配置冲掉**：config.json（端口、初始密码）和 data/
     * （聊天记录 + 明文 API Key）都在这个目录里，已存在就跳过。
     */
    private static void Unpack()
    {
        using (Stream raw = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResource))
        {
            if (raw == null) throw new InvalidOperationException("安装包里没有 " + PayloadResource + "，这个 exe 是坏的");

            using (ZipArchive zip = new ZipArchive(raw, ZipArchiveMode.Read))
            {
                string prefix = CommonPrefix(zip);
                int written = 0;
                int kept = 0;

                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    // 目录条目（名字以 / 结尾）没有内容，下面按文件处理时会自己建目录
                    string relative = entry.FullName;
                    if (prefix.Length > 0 && relative.StartsWith(prefix, StringComparison.Ordinal))
                    {
                        relative = relative.Substring(prefix.Length);
                    }
                    relative = relative.Replace('/', Path.DirectorySeparatorChar);
                    if (relative.Length == 0) continue;
                    if (entry.FullName.EndsWith("/", StringComparison.Ordinal)) continue;

                    string full = Path.Combine(target, relative);
                    if (File.Exists(full) && IsUserData(relative))
                    {
                        kept++;
                        continue;
                    }

                    string dir = Path.GetDirectoryName(full);
                    if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                    entry.ExtractToFile(full, true);
                    written++;
                }

                Console.WriteLine("         " + written + " 个文件"
                    + (kept > 0 ? "（保留了你原有的 " + kept + " 个配置/数据文件）" : ""));
            }
        }
    }

    /** zip 里是不是所有条目都在同一个顶层目录下；不是的话返回空串（就不剥） */
    private static string CommonPrefix(ZipArchive zip)
    {
        string prefix = null;
        foreach (ZipArchiveEntry entry in zip.Entries)
        {
            int slash = entry.FullName.IndexOf('/');
            if (slash <= 0) return string.Empty; // 有平铺在根上的文件 → 没有统一前缀
            string first = entry.FullName.Substring(0, slash + 1);
            if (prefix == null) prefix = first;
            else if (prefix != first) return string.Empty;
        }
        return prefix == null ? string.Empty : prefix;
    }

    /** 这些是用户自己的东西，升级/重装时不许覆盖 */
    private static bool IsUserData(string relative)
    {
        if (relative == "config.json") return true;
        return relative.StartsWith("data" + Path.DirectorySeparatorChar, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------------ 快捷方式

    /** 建一个 .lnk，指到 target 里的启动脚本。失败只警告，不让整个安装挂掉。 */
    private static string MakeShortcut(string lnkPath, string launch)
    {
        try
        {
            string dir = Path.GetDirectoryName(lnkPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            // WScript.Shell 没有强类型接口可用，只能晚绑定。多几行，但不引任何依赖。
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            object lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
            Type lnkType = lnk.GetType();
            lnkType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { launch });
            lnkType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { target });
            lnkType.InvokeMember("Description", BindingFlags.SetProperty, null, lnk, new object[] { "启动 AI 问答网站" });
            lnkType.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
            Console.WriteLine("         " + lnkPath);
        }
        catch (Exception ex)
        {
            Console.WriteLine("         ! 快捷方式没建成（" + ex.Message + "），不影响使用，去装目录双击 " + LaunchScript + " 也一样");
        }
        return lnkPath;
    }

    // ------------------------------------------------------------------ 卸载

    /**
     * 写卸载入口：一个纯 ASCII 的 卸载.cmd，加一个带中文的 uninstall.ps1。
     *
     * 为什么拆成两个文件 —— 绕不开的编码问题：
     *
     *   · cmd.exe 按**系统 OEM 代码页**解析批处理文件。中文 Windows 上是 GBK，
     *     于是「以 UTF-8 存的中文」在 .cmd 里会被解码成乱码，用它去 del/rmdir
     *     只会静默失败（实测：「AI 网站.lnk」被读成「AI ??.lnk」）。
     *     给 .cmd 加 UTF-8 BOM 能让它按 UTF-8 解析，但 BOM 会粘在第一个 token 上，
     *     `@echo off` 变成未知命令、echo 关不掉，满屏回显（也实测过）。
     *     → 结论：.cmd 里一个非 ASCII 字符都不能有，中文路径更不行。
     *
     *   · PowerShell 5.1 正好相反：**看到 UTF-8 BOM 才按 UTF-8 解析** .ps1，
     *     没有 BOM 才按 ANSI 代码页读。所以中文全放 .ps1 里，由它来删。
     *
     * 顺带解决「自己删自己」：要删的目录里正躺着正在执行的 卸载.cmd，
     * cmd.exe 还开着它，原地 rmdir 会被 Windows 拒掉（文件被占用，实测目录只删掉一部分）。
     * 所以 .cmd 先把两个文件复制到 %TEMP%，再执行那份拷贝。
     *
     * 「按任意键继续」用 .cmd 的 pause、不用 PowerShell 的 ReadKey：
     * ReadKey 是直接读控制台输入缓冲区的，实测在输入被重定向的场景下会一直卡着不返回
     * （脚本里调用、自动化测试都会踩到）。pause 在两种场景下表现都对。
     */
    private static void WriteUninstaller()
    {
        string[] lines = new string[]
        {
            "@echo off",
            "rem Uninstaller for AI Website.",
            "rem",
            "rem MUST stay pure ASCII. cmd.exe parses .cmd files with the system OEM code",
            "rem page, so any Chinese path written here would be decoded wrong and every",
            "rem del/rmdir below would silently fail. All the Chinese lives in uninstall.ps1,",
            "rem which is UTF-8 with a BOM - the encoding PowerShell 5.1 actually reads.",
            "rem",
            "rem The copy-to-%TEMP% dance exists because the folder being deleted contains",
            "rem this very file; cmd.exe keeps it open, so removing the folder in place gets",
            "rem refused by Windows. Running the copy from %TEMP% frees it.",
            "",
            "if \"%~1\"==\"go\" goto run",
            "copy /y \"%~f0\" \"%TEMP%\\ai-website-uninstall.cmd\" >nul 2>&1",
            "copy /y \"%~dp0uninstall.ps1\" \"%TEMP%\\ai-website-uninstall.ps1\" >nul 2>&1",
            "start \"\" \"%TEMP%\\ai-website-uninstall.cmd\" go",
            "exit /b 0",
            "",
            ":run",
            "echo.",
            "echo   Uninstall AI Website",
            "echo.",
            "echo   This deletes the program, its settings, your API keys and your chat history.",
            "echo   Press any key to continue, or close this window to cancel.",
            "pause >nul",
            // 绝对路径叫 powershell，免得 PATH 里有人塞了个同名的东西
            "\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"%TEMP%\\ai-website-uninstall.ps1\"",
            "exit /b 0",
            "",
        };
        File.WriteAllText(Path.Combine(target, UninstallScript), string.Join("\r\n", lines), Encoding.ASCII);

        // UTF8Encoding(true) = 带 BOM。没有 BOM，PowerShell 5.1 会按 ANSI 读，
        // 下面那些中文路径就全成乱码了。
        File.WriteAllText(Path.Combine(target, PsUninstallScript), UninstallPs1(), new UTF8Encoding(true));
    }

    private static string UninstallPs1()
    {
        return string.Join("\r\n", new string[]
        {
            "# 卸载 AI 网站。",
            "#",
            "# 由 %TEMP% 里那份 卸载.cmd 调起来（它先把本文件复制过去再执行），",
            "# 所以下面删自己所在的目录时，没有任何文件还被占用着。",
            "",
            "$appDir = '" + target + "'",
            "$shortcut = '" + AppTitle + ".lnk'",
            "",
            "$failed = @()",
            "",
            "# 开始菜单和桌面这两个快捷方式",
            "foreach ($folder in @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs'))) {",
            "  $lnk = Join-Path $folder $shortcut",
            "  if (Test-Path -LiteralPath $lnk) {",
            "    try { Remove-Item -LiteralPath $lnk -Force -ErrorAction Stop } catch { $failed += $lnk }",
            "  }",
            "}",
            "",
            "# 「设置 → 应用 → 已安装的应用」里那一条",
            "if (Test-Path -Path ('HKCU:\\' + '" + UninstallKey + "')) {",
            "  try { Remove-Item -Path ('HKCU:\\' + '" + UninstallKey + "') -Recurse -Force -ErrorAction Stop } catch { $failed += 'registry entry' }",
            "}",
            "",
            "# 程序目录。先把自己挪到 %TEMP%，否则当前目录如果正好在待删目录里，Windows 会拒绝删除",
            "Set-Location $env:TEMP",
            "try { Remove-Item -LiteralPath $appDir -Recurse -Force -ErrorAction Stop } catch { $failed += $appDir }",
            "",
            "Write-Host ''",
            "if (Test-Path -LiteralPath $appDir) {",
            "  Write-Host '  目录没删干净 —— 多半是网站还开着。'",
            "  Write-Host '  把那个标题是 AI 问答网站的窗口关掉，再运行一次卸载就行。'",
            "} else {",
            "  Write-Host '  已删除。'",
            "}",
            "if ($failed.Count -gt 0) {",
            "  Write-Host '  这几样没删掉：'",
            "  foreach ($f in $failed) { Write-Host ('    ' + $f) }",
            "}",
            "Start-Sleep -Seconds 3",
            "",
        });
    }

    /** 一条 HKCU 卸载项，让它出现在「设置 → 应用 → 已安装的应用」里。写不进去不影响安装。 */
    private static void RegisterUninstaller()
    {
        try
        {
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                if (key == null) return;
                key.SetValue("DisplayName", "AI 问答网站");
                key.SetValue("DisplayVersion", Version);
                key.SetValue("Publisher", "AI Website");
                key.SetValue("InstallLocation", target);
                key.SetValue("UninstallString", "cmd /c \"\"" + Path.Combine(target, UninstallScript) + "\"\"");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("         ! 卸载入口没写进注册表（" + ex.Message + "），直接删目录也一样");
        }
    }

    /** 双击打开时窗口会随进程结束而消失，出错信息必须留一会儿 */
    private static void PauseIfInteractive()
    {
        try
        {
            if (!Console.IsInputRedirected)
            {
                Console.Write("  按回车键关闭…");
                Console.ReadLine();
            }
        }
        catch { /* 没控制台就算了 */ }
    }
}
