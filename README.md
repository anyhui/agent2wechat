# agent2wechat

把 AI 智能体接到微信：通过腾讯官方 iLink Bot API（ClawBot 通道），智能体在微信私聊里收发文字、语音、图片、文件和视频。桥接本身不绑定任何智能体框架——它只维护一套文件队列，任何能读写文件的智能体都能接入。

Bridge an AI agent to WeChat via Tencent's official iLink Bot API (the ClawBot channel): text, voice, images, files and video in a private chat. The bridge is framework-agnostic — it exposes a file-queue interface that any agent able to read and write files can use.

## 功能

- **收**：文字、语音（微信自带转文字）、图片、文件、视频；媒体自动从 CDN 下载并 AES 解密到本地。
- **发**：纯文本（微信不渲染 Markdown），以及图片、视频、文件附件（加密上传 CDN 后发送）。
- **只服务绑定者本人**：每个 binding 扫码绑定谁，就只接受谁的私聊消息，其余一律忽略。
- **多绑定**：一个守护进程可并行运行多个 binding；每个 binding 独立保存凭证、轮询游标、上下文和登录状态，一个 binding 过期不会停掉其他 binding。消息与回复都带 `binding` 字段并按它路由。
- **发送可靠性**：outbox 由独立循环每 2 秒处理，普通发送失败最多重试 3 次（凭证过期 -14 不重试）；扫码二维码过期时自动刷新，最多 3 张。
- **纯出站**：只发 HTTPS 出站请求，不开放任何端口，不接管微信号（读不到好友聊天，不能给好友/群发消息）。
- **附带巡检脚本，需另行配置**：桥接程序本身不带自动巡检，也不会自愈。`examples/` 附带巡检脚本和 hook 模板，部署者另行配置定时 hook（参考实现为每 120 秒一次）后，服务被杀/机器重启后才可自动重装拉起。

## 架构

```
微信 ClawBot 私聊
   │  iLink Bot API（ilinkai.weixin.qq.com）
   ▼
bridge.mjs 守护进程（systemd 服务 agent2wechat，一个进程并行轮询全部 binding）
   │  getupdates 长轮询收消息 → inbox/（消息带 binding，媒体解密后放 media-in/）
   │  读取 outbox/ → 按 binding 选择凭证 → sendmessage 发回（带原对话 context_token）
   ▼
文件队列  ←→  你的智能体（轮询 inbox/，把回复写进 outbox/）
```

媒体走微信 CDN：`getuploadurl` 拿上传参数 → AES-128-ECB（PKCS#7）加密后 POST 上传 → 从响应头 `x-encrypted-param` 取得下载参数再组装消息发送；入站媒体按消息里的密钥下载解密。协议细节见腾讯官方仓库 openclaw-weixin 的 `docs/protocol.md`。

## 文件队列接口（智能体对接契约）

入站消息（`inbox/<id>.json`）：

```json
{
  "id": "消息ID",
  "binding": "default",
  "from_user_id": "绑定者ID",
  "text": "文字内容（语音为转写文本）",
  "has_media": true,
  "media_files": [{"kind": "image", "path": "media-in/下文件的绝对路径", "file_name": "a.jpg", "size": 12345}],
  "context_token": "回复时原样带回",
  "received_at": "ISO 时间"
}
```

出站回复（写到 `outbox/<同名>.reply.json`，守护进程发出后移入 `sent/`）：

```json
{
  "binding": "入站消息的 binding，缺失时为 default",
  "to_user_id": "绑定者ID",
  "context_token": "入站消息的 context_token",
  "text": "纯文本回复，不要用 Markdown",
  "attachments": ["/绝对路径/图片.jpg", "/绝对路径/文件.pdf"]
}
```

`attachments` 可选，按扩展名判断图片/视频/文件。处理完的入站文件请移入 `processed/`，避免重复处理。

会话连续性由智能体侧负责：桥接只转发消息，不保存对话上下文。推荐按 binding 维护滚动记录：默认 binding 用 `chat-log.md`，其他 binding 用 `chat-logs/<binding>.md`（结构均为「此前概要」+「近期对话」两部分），避免不同绑定串话。处理每条消息前先读对应记录，处理后把本轮往来追加进去；记录过长时把较早的部分概括折叠进概要，保持总量有界。绑定者发 `new` 时只清空自己 binding 的记录。具体指令写法见 `examples/hook-prompt-inbox.md`。

## 安装与运行

环境：Linux + systemd、Node.js 18+（用到全局 fetch 与 `NODE_USE_ENV_PROXY`）、网络能出站访问 `*.weixin.qq.com`。

```bash
# 1. 安装并启动服务（会把当前 shell 的代理变量写进服务单元并持久化到 proxy-env.sh）
bash install-service.sh

# 2. 扫码绑定（先停服务，生成二维码，用微信扫；二维码过期会自动刷新，最多 3 张）
systemctl stop agent2wechat
node bridge.mjs login          # 默认 binding；二维码信息在 login/qr.json，验证码写 login/verify.txt
systemctl start agent2wechat

# 3. 查看状态
node bridge.mjs status         # 全部 binding 的 logged_in / auth_status / 队列积压 / 最近轮询时间
node bridge.mjs bindings       # 列出已登记的 binding
```

新增 binding（名称仅限小写字母、数字、下划线、连字符，最长 32 个字符）：

```bash
systemctl stop agent2wechat
node bridge.mjs login work     # 自动登记 work；凭证写 accounts/work/state.json，二维码在 login/work/qr.json
systemctl start agent2wechat
```

手动给绑定者发一个文件（调试）：`node bridge.mjs send-file [--binding <名称>] <路径>`。

## 目录

| 路径 | 说明 |
| --- | --- |
| `bridge.mjs` | 守护进程 + 命令行工具（login [binding] / bindings / run / status / send-file） |
| `install-service.sh` | 生成 systemd 单元并安装 |
| `bridge.config.json`（勿提交） | 非密钥配置：binding 名称与 state 文件路径；格式见 `bridge.config.example.json` |
| `state.json`（600，勿提交） | 默认 binding 的登录凭证、绑定关系、轮询游标——**绝密，不外传** |
| `accounts/<binding>/state.json`（600，勿提交） | 附加 binding 各自的登录凭证、绑定关系、轮询游标 |
| `statuses/<binding>.json` | 每个 binding 的运行状态；根 `status.json` 汇总全部 binding |
| `proxy-env.sh`（600，勿提交） | 出站代理变量，供无人值守重装复用 |
| `chat-log.md` / `chat-logs/<binding>.md`（勿提交） | 智能体侧按 binding 维护的滚动会话记录（概要 + 近期对话），让连续聊天不断片且不串话 |
| `inbox/ processed/ outbox/ sent/ failed/` | 消息与回复队列 |
| `media-in/` | 入站媒体解密后的文件 |
| `alerts/` | 凭证过期等告警 |
| `logs/bridge.log` | 守护进程日志 |
| `examples/` | 与 Muse hooks 的参考对接（消息处理 + 服务巡检脚本与 hook 模板，需另行配置，不是桥接内置功能） |

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 微信显示「暂时无法连接」 | 服务不在（机器重启/被杀） | `bash install-service.sh` 重装；如已另行配置巡检 hook，也可等它自动恢复 |
| getupdates 一直 `fetch failed` | 服务单元缺出站代理变量 | 重跑 `install-service.sh`（从 `proxy-env.sh` 复用） |
| 返回 -14 / auth expired | 某个 binding 的登录凭证过期 | 停服务 → `node bridge.mjs login <binding>` 只重登该 binding → 启服务；其他 binding 不受影响 |
| 二维码过期 | 一张二维码超时 | 登录程序自动刷新，最多 3 张；仍未扫再重新运行登录命令 |

## 安全说明

- bot token 只存各 binding 的 `state.json`（权限 600），不要提交到仓库、不要贴到聊天或日志里；非密钥配置单独放 `bridge.config.json`。
- 每个 binding 只响应其扫码绑定者的私聊，不同 binding 相互隔离；这是官方 ClawBot 直聊通道，不是微信号托管。
- 若运行环境会周期性重置（如云端沙箱），把项目目录放在持久化存储上，并按 `examples/` 另行配置巡检 hook；只装桥接本身不会自动恢复。

## License

MIT
