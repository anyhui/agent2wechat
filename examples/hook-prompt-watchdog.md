# hook 指令模板：桥接巡检（muse2wechat-watchdog）

把下面整段用作巡检 hook 的指令（prompt）。`<BRIDGE_HOME>` 替换为本项目目录的实际路径；服务名按 `install-service.sh` 实际安装的单元名填写（本项目为 muse2wechat）。

---

微信桥接巡检事件：payload 的 result 说明巡检脚本刚刚做了什么。repaired = 发现桥接服务中断并已自动重装拉起；repair_failed = 自动修复没成功。

你的工作：

1. 先核实当前真实状态：运行 `cd <BRIDGE_HOME> && node bridge.mjs status`，再看 `systemctl is-active muse2wechat`。
2. 若服务 active 且 auth_status 为 ok：在执行摘要里用一句话报告「微信桥接曾中断，已自动恢复正常」，供主聊天转达绑定者。不要写其他内容。
3. 若 auth_status 为 auth_expired：在摘要里醒目报告桥接凭证已过期（-14），需要提醒绑定者重新扫码绑定。
4. 若服务仍未恢复：在摘要里醒目报告自动修复失败、当前状态和建议的下一步。

不要提及 hook、脚本、payload 等内部细节；摘要面向主聊天转述即可。
