# 隐私说明 · Privacy Policy

本文件描述的是**这个程序本身**会收集和存储什么。它是一个可以自己部署的开源项目：
每个实例由部署它的人运营，**该实例的运营者才是数据的责任方**。下面「本实例」指的是
公开演示站 <https://chat-inon.lumewalk.dpdns.org>，运营者为 `weiguang1678`。

> This document describes what **the software itself** collects and stores. This is a
> self-hostable open-source project: each deployment is run by whoever deploys it, and
> **that operator is the data controller**. In this document, "this instance" refers to the
> public demo at <https://chat-inon.lumewalk.dpdns.org>, operated by `weiguang1678`.
> An English summary is provided at the end.

最后更新：2026-10-14

---

## 一、访客（使用问答界面的人）

**会存到服务器上的**

| 数据 | 说明 |
| --- | --- |
| 你输入的秘钥 | 由管理员生成并分发，在服务器数据库里以明文保存（后台需要展示它去分发） |
| 秘钥的最后使用时间、最后使用的 IP | 每把秘钥记录这两项，用于管理员判断是否需要停用该秘钥 |

**不会存到服务器上的**

- **你的对话内容不落库。** 你问的问题和 AI 的回答只经过服务器转发，不会被写进服务器的数据库；
  对话历史保存在**你自己浏览器**的本地存储里，点「清空」或「退出登录」就删掉了。
- **不记录访问日志。** 程序不写访问日志到磁盘，启动窗口里只打印启动信息。

**会离开这台机器的**

- 你发的提问、最近若干条历史消息、以及管理员配置的系统提示词，会被转发给**管理员在后台配置的
  第三方 AI 接口**（例如 DeepSeek、月之暗面、硅基流动、OpenAI 或某个中转站）。
  也就是说：**对话内容会交给那家 AI 服务商**，它如何保存和处理，取决于该服务商的隐私政策。
  请不要在对话里输入你不希望被第三方看到的内容（身份证号、口令、私钥等）。
- 若通过 Cloudflare Tunnel 发布到公网，流量会经过 Cloudflare 的边缘节点。

**Cookie**

访客**不会**收到任何 Cookie。进入用的令牌只保存在页面内存里，刷新页面即失效、需要重新输入。

## 二、管理员（登录后台的人）

- 后台登录使用一枚 `HttpOnly` + `SameSite=Lax` 的会话 Cookie；登录状态在服务器**内存**里维持
  （默认 12 小时），**服务重启即全部失效**。
- 后台里配置的 AI 接口地址与 API Key 保存在服务器本地的 `data/db.json`，**不会下发到浏览器**，
  调用 AI 接口全部在服务端完成。
- 后台的「运行日志」记录的是欢迎语学习任务的运行情况，不含访客的对话内容。

## 三、这份数据放在哪、留多久

- 所有服务器端数据都在**部署者自己那台机器**上的 `data/db.json` 里，不经过本项目的任何服务器
  （本项目没有运营任何云端服务）。
- 秘钥记录保留到管理员在后台删除为止；会话数据在过期或重启后消失。
- 浏览器里的对话历史由访客自己掌握，清空即删除。

## 四、不做什么

- 没有统计脚本、没有广告、没有第三方分析服务，页面不向外部加载任何资源。
- 不收集访客的设备指纹，不做画像，不把数据卖给任何人。
- 不代第三方收集数据：除了上面写明的 AI 接口转发，不会把数据发给别处。

## 五、联系方式

数据相关问题请到仓库开 issue：<https://github.com/weiguang1678/AI-website/issues>

---

## English summary

**Stored server-side (`data/db.json`, on the operator's own machine):** the access keys you
type (stored in plain text — the admin UI has to display them for distribution), and for each
key its last-used timestamp and last-used IP address. Admin settings, including the AI API
base URL and API key, are stored there too.

**Not stored server-side:** chat content is **not** persisted — messages are only relayed
through the server; conversation history lives in your own browser's local storage and is
deleted when you clear it or sign out. No access logs are written to disk.

**Leaves the machine:** your messages, a limited number of recent history entries and the
operator's system prompt are forwarded to the **third-party AI API endpoint the operator
configured**. Their handling of that data is governed by their own policy. Traffic also passes
through Cloudflare's edge if the site is published via Cloudflare Tunnel.

**Cookies:** visitors receive none — the unlock token lives in page memory only and is lost on
refresh. The admin login uses one `HttpOnly`/`SameSite=Lax` session cookie backed by an
in-memory session (12 h TTL, cleared on restart).

**Where the data lives:** entirely on the machine of whoever deployed this software. The
project itself operates no servers, no analytics, no ads, and no fingerprinting.
