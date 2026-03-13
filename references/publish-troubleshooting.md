# 番茄小说发布流程 - 完整指南与踩坑记录

> 最后更新：2026-03-12
> 调试环境：headless Chromium (Playwright)，container 环境

---

## 一、发布章节完整流程（已验证）

### 关键 URL
| 用途 | URL |
|------|-----|
| 登录页 | `https://fanqienovel.com/main/writer/login` |
| 作品管理 | `https://fanqienovel.com/main/writer/book-manage` |
| 发布章节（新建） | `https://fanqienovel.com/main/writer/{bookId}/publish/?enter_from=newchapter_1` |
| 发布章节（复用草稿） | `https://fanqienovel.com/main/writer/{bookId}/publish/{itemId}?enter_from=newchapter_1` |

### DOM 选择器
| 元素 | 选择器 |
|------|--------|
| 章节序号输入框 | `input.serial-input` |
| 章节标题输入框 | `input.serial-editor-input-hint-area` |
| 正文编辑器 | `.syl-editor-container .ProseMirror` |
| 字数显示 | `document.body.innerText.match(/正文字数\s*\n(\d+)/)` |
| 引导弹窗 | `#___reactour`（需在操作前 remove） |

### 发布步骤详解

**第 0 步：进入发布页**
```js
await page.goto(`https://fanqienovel.com/main/writer/${bookId}/publish/?enter_from=newchapter_1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await page.evaluate(() => document.querySelector('#___reactour')?.remove());
// 如果弹出"有刚刚更新的草稿，是否继续编辑？"→ 点"放弃"开新章节
if (await page.locator('button:has-text("放弃")').count() > 0) {
  await page.locator('button:has-text("放弃")').click();
  await page.waitForTimeout(1000);
}
```

**第 1 步：填章节序号**
```js
// ⚠️ 必须用 focus() + keyboard.type，不能用 fill() 或 React setter
await page.evaluate(() => document.querySelector('input.serial-input')?.focus());
await page.keyboard.type('1');
await page.keyboard.press('Tab');
await page.waitForTimeout(200);
```

**第 2 步：填章节标题**
```js
await page.evaluate(() => document.querySelector('input.serial-editor-input-hint-area')?.focus());
await page.keyboard.type('章节标题');
await page.keyboard.press('Tab');
await page.waitForTimeout(200);
```

**第 3 步：填正文（关键！）**
```js
// ⚠️ 必须先用 JS 把光标定位到编辑器末尾，再用 keyboard.type 分批输入
await page.evaluate(() => {
  const pm = document.querySelector('.syl-editor-container .ProseMirror');
  pm.focus();
  const sel = window.getSelection(), range = document.createRange();
  range.selectNodeContents(pm);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
});
await page.waitForTimeout(300);
// 分批输入，每批 80 字，避免超时
for (let i = 0; i < content.length; i += 80) {
  await page.keyboard.type(content.slice(i, i + 80), { delay: 0 });
  await page.waitForTimeout(20);
}
await page.waitForTimeout(2000);
// 验证字数 >= 1000
const wc = await page.evaluate(() => document.body.innerText.match(/正文字数\s*\n(\d+)/)?.[1] || '0');
```

**第 4 步：点"下一步"**
```js
await page.locator('button:has-text("下一步")').first().click({ force: true, timeout: 8000 });
await page.waitForTimeout(2500);
```

**第 5 步：走分卷向导（点两次"下一步"）**
- 侧边弹出分卷向导（4 步），内容是作品大纲/人物卡片等，直接连点两次"下一步"跳过
```js
for (let i = 0; i < 2; i++) {
  await page.locator('button:has-text("下一步")').last().click({ force: true, timeout: 5000 });
  await page.waitForTimeout(2000);
}
```

**第 6 步：风险检测弹窗 → 点"取消"跳过**
- 弹窗内容："是否进行内容风险检测？开启后将消耗使用次数"
- 点"取消"跳过，不影响发布
```js
if (btns.includes('确定') && btns.includes('取消')) {
  await page.locator('button:has-text("取消")').last().click({ timeout: 5000 });
  await page.waitForTimeout(2000);
}
```

**第 7 步：发布设置弹窗 → 选"AI=是" → 点"确认发布"**
- ⚠️ **必须先选"是否使用AI = 是"，否则发布失败（0章）**
- AI 生成内容必须标注为 AI，避免版权问题
```js
// 选 AI = 是
await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.arco-radio, .arco-radio-wrapper, label, span'));
  for (const el of items) {
    if (el.innerText?.trim() === '是' && el.offsetParent !== null) {
      el.click();
      return;
    }
  }
});
await page.waitForTimeout(500);
// 确认发布
await page.locator('button:has-text("确认发布")').first().click({ timeout: 8000 });
await page.waitForTimeout(5000);
```

**发布成功标志：**
- 弹窗关闭，页面跳转到章节管理界面
- 章节状态显示"审核中"
- 作品管理页显示"1 章"

---

## 二、踩坑清单（必看！）

### 🔴 正文填写问题（最大坑）

**❌ 以下方式全部无效（不触发 React state）：**
```js
// 无效1：clipboard 粘贴
await page.evaluate(text => navigator.clipboard.writeText(text), content);
await page.keyboard.press('Control+v');

// 无效2：execCommand
document.execCommand('insertText', false, text);  // 返回 false

// 无效3：React nativeInputValueSetter
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
// 在 page.evaluate 中会报 TypeError: Illegal invocation

// 无效4：直接 editor.fill()
// ProseMirror 不是 input 元素，fill() 无效

// 无效5：直接 editor.click() + keyboard.type
// ❌ 因为编辑器第一个 <p> 里有 contenteditable="false" 的 ProseMirror-widget
// 直接 click 后 keyboard.type 内容进不去，字数保持 0
```

**✅ 唯一有效方式：**
```js
// 先用 JS 把光标定位到编辑器末尾（绕过 widget）
await page.evaluate(() => {
  const pm = document.querySelector('.syl-editor-container .ProseMirror');
  pm.focus();
  const sel = window.getSelection(), range = document.createRange();
  range.selectNodeContents(pm);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
});
// 再分批 keyboard.type
for (let i = 0; i < content.length; i += 80) {
  await page.keyboard.type(content.slice(i, i + 80), { delay: 0 });
  await page.waitForTimeout(20);
}
```

**根本原因：** ProseMirror 编辑器第一个 `<p>` 内嵌了 `contenteditable="false"` 的 widget（AI 提示占位符）。直接 click 后光标落在 widget 上而非可编辑区域，所有键盘输入被丢弃。必须用 `getSelection().addRange()` 手动把光标放到编辑器末尾。

### 🔴 序号填写问题

**❌ 无效方式：**
```js
// fill() 后 React 检测到的值是空的（显示验证错误"章节序号只支持阿拉伯数字"）
await page.locator('input.serial-input').fill('1');

// React setter 在某些 evaluate 上下文报 Illegal invocation
```

**✅ 有效方式：**
```js
await page.evaluate(() => document.querySelector('input.serial-input')?.focus());
await page.keyboard.type('1');
await page.keyboard.press('Tab');
```

### 🔴 发布设置必须选"是否使用AI"

- 不选"是/否"直接点"确认发布"：**弹窗关闭但章节不发布（0章）**
- **必须选「是」（AI生成）**，再点"确认发布"
- 选「否」会触发版权问题（声明非AI生成但内容由AI创作）

### 🟡 草稿弹窗

- 每次 goto 发布页，如果之前有未完成的草稿，会弹"是否继续编辑？"
- 点"放弃"→ 开全新章节（推荐）
- 点"继续编辑"→ 加载旧草稿，但正文 React state 仍为 0（草稿内容不同步到编辑器状态）

### 🟡 每次 goto 创建新 chapterId

- 每次访问 `…/publish/?enter_from=newchapter_1` 都会生成新的 chapterId
- 不能分两次跑（第一次填内容，第二次提交）——第二次又是新 chapterId
- **必须在同一个 browser session 里一次性完成填写+发布**

### 🟡 分卷向导（每次发布都会出现）

- 点"下一步"后，左侧弹出分卷向导侧边栏（4步：分卷/人物/世界观等）
- 需要连点两次向导里的"下一步"才能到达风险检测弹窗
- 这是每次发布都会出现的流程，无法跳过

### 🟡 风险检测弹窗

- 内容："是否进行内容风险检测？将消耗使用次数"
- 不需要选，点"取消"跳过即可正常发布

---

## 三、登录方式

**❌ 无法自动登录：**
- 密码登录：页面强制要求手机验证码（"为保证账号安全，请使用手机验证码登录"）
- 验证码登录：字节跳动检测到 headless UA，触发滑块验证码，无法自动解决

**✅ Cookie 方式：**
1. 老板在真实浏览器登录番茄小说
2. DevTools → Application → Cookies → 复制全部 Cookie 字符串
3. 告诉秘书，秘书保存到 `~/.tomato-writer-session.json`
4. Cookie 有效期约 60 天（sid_guard 字段为准）

---

## 四、保存草稿 API（可直接调用）

```js
POST /api/author/article/cover_article/v0/
Content-Type: application/x-www-form-urlencoded

aid=2503&app_name=muye_novel&book_id={bookId}&item_id={itemId}
&title={title}&content={htmlContent}&volume_name={volumeName}&volume_id={volumeId}
```

- 返回 `{code:0, message:"success"}` = 成功
- **注意：此 API 只保存到服务端，不同步到浏览器 React state，无法用于触发发布**
- 用途：在填写正文之前预存内容备份，或更新标题

---

## 五、作品信息（当前）

| 字段 | 值 |
|------|-----|
| 书名 | 全球升温，冰川融化，木筏开局 |
| bookId | `7614138753522617369` |
| volumeId | `7614138756739648537` |
| volumeName | 第一卷：默认 |
| 账号昵称 | 我是大龙虾 |
| Cookie 文件 | `~/.tomato-writer-session.json` |
| Cookie 到期 | 约 2026-05-11 |
