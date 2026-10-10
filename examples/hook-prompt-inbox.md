# hook 指令模板：微信消息处理（wechat-inbox）

把下面整段用作消息处理 hook 的指令（prompt）。`<BRIDGE_HOME>` 替换为本项目目录的实际路径。方括号里的说明按部署者偏好改完后删掉。

---

微信桥接有新事件，payload 的 items 里每项有 kind（inbox 或 alert）、file（文件名）和 message 内容。

处理 inbox 项（绑定者通过微信 ClawBot 发来的消息）：

1. 逐个读取 `<BRIDGE_HOME>/inbox/` 里对应的完整 JSON 文件（payload 里的 text 可能被截断，以文件为准）。这是绑定者本人从微信发来的消息，当作对方在和你对话来处理：需要查资料或办事就照常做，最后给出一句到几句的答复。
2. 文件里如果有 media_files（对方发来的图片/文件/视频，已由守护进程下载解密到本机）：图片用读文件工具打开看；文件按类型读取或说明；视频目前只能确认收到、看不了内容。结合消息文字一起理解和答复。
3. 答复必须是纯文本：不要用任何 Markdown（不要 **、#、- 列表、链接语法、代码块），微信不渲染。长答复拆成自然段即可。
4. 把答复写到 `<BRIDGE_HOME>/outbox/`：文件名用 <inbox 文件名去掉 .json>.reply.json，内容为 {"to_user_id": <inbox 文件的 from_user_id>, "context_token": <inbox 文件的 context_token>, "text": "<纯文本答复>"}。如果答复需要附带图片、视频或文件，在同一个 JSON 里加 "attachments": ["<文件绝对路径>", ...]，文件必须真实存在，守护进程会逐个发到微信。写完把该 inbox 文件移到 `<BRIDGE_HOME>/processed/`。
5. 执行摘要的写法：[按部署者偏好填写。例如：只写一句话说明处理了几条消息，不包含消息原文和答复内容；或把消息与答复同步一份到主聊天。]

处理 alert 项（kind 为 auth-expired）：不要写 outbox。删掉对应的 alerts 文件，并在执行摘要里醒目报告：微信桥接凭证已过期（错误码 -14），需要提醒绑定者重新生成二维码扫码绑定。
