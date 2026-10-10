# examples — 与 Muse hooks 的参考对接

桥接本体只提供文件队列（见上级 README 的「文件队列接口」）。这一目录给出把队列接到 Muse hook 机制上的完整参考实现，其他智能体框架可按同样的队列契约自行对接。

注意：服务巡检不是桥接程序内置的功能，本目录只是附带巡检脚本和 hook 指令模板，必须由部署者按下面说明另行创建定时 hook 才会生效；只安装桥接服务本身不会自动巡检、不会自动恢复。

## 需要创建的两个 hook

在 Muse 里各建一个 hook，脚本用本目录的 .sh，指令（prompt）用本目录对应的模板：

| hook | 脚本 | 轮询间隔 | 指令模板 | 作用 |
| --- | --- | --- | --- | --- |
| 消息处理 | `wechat-inbox.sh` | 15 秒 | `hook-prompt-inbox.md` | 轮询 inbox/ 与 alerts/，有新消息就唤醒智能体处理并回写 outbox/ |
| 服务巡检 | `agent2wechat-watchdog.sh` | 120 秒 | `hook-prompt-watchdog.md` | 轮询 systemd 服务状态，发现丢失就重跑 install-service.sh 拉起并唤醒上报 |

## 约定

- 队列根目录可用环境变量 `WECHAT_BRIDGE_HOME` 覆盖，默认 `$HOME/workspace/agent2wechat`。
- 指令模板里的 `<BRIDGE_HOME>` 要替换成本项目目录的实际路径；带方括号的说明是给部署者看的，改完删掉。
- 回复纪律（纯文本、不带 Markdown）、outbox 写法、过期告警上报，都写在指令模板里，部署时按模板原文使用即可；只有「执行摘要写多细」这类偏好项需要部署者自己定。
- 会话连续性靠按 binding 分开的滚动记录（默认 `chat-log.md`，其他 binding 用 `chat-logs/<binding>.md`；概要 + 近期对话，含 `new` 只清空自己 binding 的记录）：读、追加、折叠的规则都在消息处理指令模板里；记录文件只放桥接目录，不要提交到仓库（.gitignore 已排除）。
