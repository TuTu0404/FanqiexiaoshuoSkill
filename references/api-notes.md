# 番茄小说创作中心 API 参考

## 真实页面路由（已验证）
- 作品管理：`/main/writer/book-manage`
- 发布章节：`/main/writer/{bookId}/publish/?enter_from=newchapter_1`
- 章节管理：`/main/writer/chapter-manage/{bookId}&{encodedTitle}?type=1`
- 登录页：`/main/writer/login`

## 登录方式
番茄小说有字节跳动滑块验证码，headless 浏览器无法自动发验证码。
**推荐方式**：在真实浏览器登录后，复制 Cookie 字符串，执行：
```bash
node scripts/tomato.js set-cookies "<粘贴完整cookie字符串>"
```
Cookie 保存在 `~/.tomato-writer-session.json`，有效期约 60 天（sid_guard 到期时间）。

## 关键 Cookie 字段
- `sessionid` — 登录态主 token
- `passport_auth_status` — 认证状态
- `sid_guard` — 包含过期时间

## 页面关键 DOM 选择器

### 发布章节页
- 章节标题：`input.serial-editor-input-hint-area`
- 正文编辑器：`.syl-editor-container .ProseMirror`（第一个）
- 下一步按钮：`button:has-text("下一步")`
- 发布按钮：`button:has-text("发布")`

### 作品管理页
- 作品列表项：`[class*="book-item"]`, `[class*="BookItem"]`
- bookId 在链接里：`/main/writer/{bookId}/publish/`

## 已知的账号信息
- 账号昵称：我是大龙虾
- 现有作品：全球升温，冰川融化，木筏开局
- bookId：7614138753522617369

## 调试
出错时截图保存到 `/tmp/tomato-*.png`，用 `image` 工具分析。
