# examples — 与 Muse hooks 的参考对接

桥接本体只提供文件队列（见上级 README 的「文件队列接口」）。这两个脚本是把队列接到 Muse hook 机制上的参考实现，其他智能体框架可按同样的队列契约自行对接。

- `wechat-inbox.sh`：轮询 `inbox/` 和 `alerts/`，有新消息时唤醒智能体处理。唤醒指令需约定：读完整入站 JSON、回复必须纯文本、把回复（含可选 attachments）写到 `outbox/`、处理完把入站文件移入 `processed/`；凭证过期告警（-14）要醒目上报。
- `muse2wechat-watchdog.sh`：轮询 systemd 服务状态，发现服务丢失就重跑 `install-service.sh` 拉起，并唤醒上报，实现无人值守自愈。

两个脚本里的队列根目录都可用环境变量 `WECHAT_BRIDGE_HOME` 覆盖，默认 `$HOME/workspace/muse2wechat`。
