# muse2wechat — Muse 微信桥接

把 Muse 接到微信 ClawBot 对话里：用户在微信里给 ClawBot 发消息，小屿在主聊天处理后把纯文本回复发回微信，并同步一份到主聊天。

## 架构

- `bridge.mjs run`：systemd 常驻守护进程。只做出站 HTTPS 请求（腾讯官方 iLink 接口 ilinkai.weixin.qq.com），不开任何端口。
  - `ilink/bot/getupdates` 长轮询收消息，只接受绑定机主本人（owner_user_id）的消息，其余忽略。
  - 收到的消息写入 `inbox/`，Muse 侧的 hook（wechat-inbox，每 15 秒检查）唤醒处理。
  - 回复写入 `outbox/`，守护进程用 `ilink/bot/sendmessage` 带回最新 `context_token` 发送。
  - 凭证与状态在 `state.json`（权限 600），包含 bot token，不要外传、不要贴进聊天。
- hook `wechat-inbox`：脚本 `~/hooks/scripts/wechat-inbox.sh`，唤醒指令里规定了纯文本回复、outbox 写法和主聊天同步要求。
- 服务单元：`muse2wechat.service`（本目录有副本；系统副本在 /etc/systemd/system/）。

## 常用命令

```bash
cd ~/workspace/muse2wechat
node bridge.mjs status          # 查看登录状态、队列积压、守护进程状态
systemctl status muse2wechat  # 服务状态
systemctl restart muse2wechat # 重启服务（云电脑重启后服务会自动拉起，一般不用手动）
journalctl -u muse2wechat -n 100 --no-pager   # 看日志（或 logs/bridge.log）
```

## 云电脑被重置 / 服务不见了时重装

```bash
cd ~/workspace/muse2wechat && bash install-service.sh
```

注意：守护进程访问 iLink 必须走本机的出站代理环境变量，install-service.sh 会在安装时把当前 shell 的代理变量写进 systemd 单元（单元文件权限 600，不要把代理地址贴到聊天或外部）。手动 `systemctl start` 一个不带代理变量的单元会表现为 getupdates 一直 fetch failed。
hooks 里的 wechat-inbox 定义在 ~/hooks/ 下，一般会随工作区恢复；用 hooks.list 确认存在且 enabled。

自动巡检（2026-10-10 已启用）：hook `muse2wechat-watchdog` 每 120 秒检查服务，发现 unit 丢失或服务不在就自动跑 install-service.sh 拉起并唤醒报告。install-service.sh 会把代理变量持久化到 proxy-env.sh（600 权限），无人值守重装时自动复用，不再依赖交互 shell 的环境。

## 重新扫码绑定（首次绑定、或凭证过期时）

```bash
systemctl stop muse2wechat
cd ~/workspace/muse2wechat && node bridge.mjs login   # 生成二维码，信息写到 login/qr.json
systemctl start muse2wechat
```

二维码约 5 分钟有效。登录过程中若出现 need_verifycode，把手机上显示的验证码写进 `login/verify.txt` 再继续轮询。

## 错误码 -14（凭证过期）

getupdates 或 sendmessage 返回 -14 时，守护进程会把 state 置为 expired 并在 `alerts/` 写告警，hook 会唤醒小屿在主聊天提醒重新扫码。按上面的「重新扫码绑定」流程走一遍即可恢复，历史消息队列不受影响。

## 当前限制

- 文字、语音转文字、图片、文件、视频收发已通（2026-10-10）：出站走 getuploadurl + AES-128-ECB 加密上传（outbox 回复 JSON 带 attachments 数组，或 `node bridge.mjs send-file <路径>` 手动发）；入站媒体自动下载解密到 media-in/，inbox 记录带 media_files。视频内容暂不解析，只能收发文件本身。
- 这是与 ClawBot 的专用私聊通道，不是接管微信号：读不到好友聊天，也不能给好友发消息。

## 打包说明（2026-10-10）

本包项目名为 muse2wechat。出于安全原因，包内不含正在运行实例的 state.json（登录凭证）、proxy-env.sh（代理配置）、status.json、node_modules、登录二维码及历史消息和日志；解压后执行 npm install，并按上文重新扫码登录即可使用。
