# Google、X、GitHub 的 OAuth 兼容性

核对日期：2026-11-15。三家都能复用 Pizza 的 OAuth 引擎；目前均不能仅使用 Pizza 的 CIMD 文档自动获取应用身份。以下区分官方文档、匿名线上探测与真实账号授权。

| 服务 | 注册方式 | Pizza 接入方式 | 必要条件 |
| --- | --- | --- | --- |
| Google 正式 API / 本地 MCP 适配器 | Pizza 服务端预注册 Web 应用 | Cloudflare OAuth 中转、双段 PKCE、本机回调和刷新 | 发布方启用正式 API；终端用户只登录，无需填写密钥或申请 MCP 预览 |
| Google Workspace 官方 MCP（历史兼容配置） | 预注册 AI-agent Web 应用 | 原有远程 MCP 配置保留兼容 | 仍要求预览资格；已从内置市场撤下 |
| X | 预注册 Native/Public 应用 | PKCE、本机回调、offline.access 刷新；无需额外 xurl 进程 | 应用已开启 OAuth 2.0，回调完全匹配，API 账号具备相应访问权限 |
| GitHub | 预注册 OAuth 应用，开启 Device Flow | 设备码登录；offline_access 获取可刷新的短期令牌 | 发布方的应用开启设备码流程；组织策略可能要求批准 |

## 官方依据

- [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)：Desktop 客户端属于 public client，使用 PKCE 和本机浏览器回调；注册文件的 secret 字段不等同于可保密的 Web 服务端密钥。
- [Google Workspace MCP 配置](https://developers.google.com/workspace/guides/configure-mcp-servers)：需要预览资格及 AI-agent 客户端设置；通过 access_type=offline 请求刷新令牌，已有授权需要新刷新令牌时使用 prompt=consent。
- [X OAuth PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)：Native / SPA 为 public client；offline.access 用于获取刷新令牌。
- [X MCP](https://docs.x.com/tools/mcp)：文档描述 xurl 桥接方案，且不提供 DCR。其“未提供原生 OAuth discovery”的描述与本次线上元数据响应存在差异，因此 Pizza 使用明确配置并经过探测的元数据地址。
- [GitHub OAuth](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)：授权码交换仍要求 secret；设备码交换不要求 secret；设备码签发的刷新令牌也可免 secret 刷新。offline_access 可为单次登录请求到期令牌。
- [GitHub 维护者对 DCR/CIMD 的说明](https://github.com/github/github-mcp-server/issues/2532)：DCR 未提供；CIMD 当时尚无上线时间表。本次线上元数据同样未宣告 registration_endpoint 或 CIMD 支持。

## 线上探测结果

所有请求均未携带账户令牌，未读取账号内容。

- Google OIDC 元数据返回 200，包含 S256 和 secret-based token authentication，未宣告 DCR/CIMD。
- Google Workspace 九个产品的 initialize / tools/list 均返回 200。Gmail、Drive、Docs、Sheets、Slides、Calendar、Chat、People 返回工具；Classroom 当时返回 0 个工具，暂不作为已核实入口内置。
- 这些 200 仅表示工具描述可公开读取。Pizza 为 Workspace 入口要求先登录，不将公开工具目录视为已获账号权限。
- X 的授权服务器和 protected-resource 元数据均返回 200，支持 S256 和 public-client none；未宣告 DCR/CIMD。
- GitHub remote MCP 未携带令牌时返回 401，并给出 protected-resource 元数据地址。其 OAuth OIDC 元数据返回 200；RFC 8414 根发现地址返回 404。保留现有明确配置的 OAuth 端点。
- Pizza 已注册的 GitHub client_id 请求设备码成功，确认 Device Flow 已开启；设备码与 user_code 未写入报告，也未由本次探测授权账号。

## 实现与验证范围

- 内置八项 Google 正式 API 适配器：Gmail、Drive、Docs、Sheets、Slides、Calendar、Chat、People，共 55 个 MCP 工具。统一使用 Cloudflare OAuth 中转，发布方 Web secret 和原始 Google refresh token 不下发；已有用户自建注册仍兼容。
- GitHub 新安装请求 offline_access；为 public device flow 显式选择 none 认证，避免全局 secret-only 声明错误阻止设备令牌刷新。confidential 授权码流程仍使用 secret。
- 真实公开元数据用于离线回归，覆盖注册选择、PKCE 回调、模拟 code exchange、资源绑定和刷新；GitHub 单独覆盖无 secret 设备令牌刷新。
- Notion 已完成真实账号的整条验证。Google Drive 的正式 API 本地 MCP 已通过真实浏览器授权、Cloudflare 回调、桌面兑换、文件读取、刷新轮换和 DEV 重启恢复；历史官方 MCP 数据读取曾被拒绝，因此已切到正式 API。X/GitHub 尚无本次真实账号授权验证。详见 [Google 实号记录](google-broker.md#real-account-verification-2026-11-15)。
- 内置 Gmail 已统一走 Cloudflare 中转，不再要求打包 Desktop 注册文件。旧 Desktop 自建配置仅保留兼容。

## Google 用户无需填写 client secret 的选择

- **Desktop 公共客户端 + PKCE**：Google 当前 Desktop 文档将换取和刷新令牌的 `client_secret` 标为可选。Pizza 发布方预注册应用并内置 client ID，用户只需浏览器登录。适合普通 Google API / 本地适配器；这属于可选的高级自建配置，内置 Gmail 使用下述服务端中转。
- **正式 Google API + 服务端 OAuth 中转（当前默认）**：已实现 Cloudflare Worker，服务端持有 Web secret、处理授权码交换和刷新，桌面端完成用户登录。包含双段 PKCE、一次性授权码、浏览器绑定、资源校验和加密的 Durable Object 会话。部署及 Google 发布方注册见 [Google broker](google-broker.md)。是否可用以线上 health 和真实账号测试为准，部署代码不等于 Google 项目已配置。
- 官方 Workspace MCP 还要求 OAuth 客户端开启 AI-powered agent 选项。Desktop public client 能否同时满足该要求，尚未真实授权核实，不能直接承诺用 Desktop 注册替代官方 Web 示例。
