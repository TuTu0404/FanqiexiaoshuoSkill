# 番茄小说发布流程 - 完整指南与踩坑记录

> 最后更新：2026-03-13
> 调试环境：headless Chromium (Playwright)，container 环境

---

## 快速问题索引（先看类别，再找具体）

| # | 问题类别 | 关键词 |
|---|---------|--------|
| A | 登录 / Cookie | 过期、未找到session、login重定向 → [第三节](#三登录方式) |
| B | 正文填写 | 字数=0、fill无效、keyboard不生效 → [第二节 🔴正文](#-正文填写问题最大坑) |
| C | 发布流程弹窗 | 继续编辑、草稿弹窗、分卷向导、风险检测 → [第二节 🟡](#-草稿弹窗) |
| D | 发布后章节=0 | 确认发布静默失败 → [第二节 🔴 发布设置](#-发布设置必须选是否使用ai) |
| E | 章节管理选择器 | list-chapters空、chapter-info报错 → [第五节](#五章节管理-dom-参考) |
| F | page.evaluate 报错 | ReferenceError: xxx is not defined → [第五节 F001](#f001pageevaluate-内禁用模板字符串插值) |

---

## 一、发布章节完整流程（已验证）

### 关键 URL
| 用途 | URL |
|------|-----|
| 登录页 | `https://fanqienovel.com/main/writer/login` |
| 作品管理 | `https://fanqienovel.com/main/writer/book-manage` |
| 发布章节（新建） | `https://fanqienovel.com/main/writer/{bookId}/publish/?enter_from=newchapter_1` |
| 编辑章节 | `https://fanqienovel.com/main/writer/{bookId}/publish/{chapterId}/?enter_from=modifychapter` |
| 章节管理 | `https://fanqienovel.com/main/writer/chapter-manage/{bookId}` |

### DOM 选择器
| 元素 | 选择器 |
|------|--------|
| 章节序号输入框 | `input.serial-input` |
| 章节标题输入框 | `input.serial-editor-input-hint-area` |
| 正文编辑器 | `.syl-editor-container .ProseMirror` |
| 字数显示 | `document.body.innerText.match(/正文字数\s*\n(\d+)/)` |
| 引导弹窗 | `#___reactour`（需在操作前 remove） |

### 发布步骤详解

**第 0 步：进入发布页，处理弹窗**
```js
await page.goto(`.../${bookId}/publish/?enter_from=newchapter_1`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
await page.evaluate(() => document.querySelector('#___reactour')?.remove());
// 新建章节：如弹"草稿"弹窗 → 点"放弃"
if (await page.locator('button:has-text("放弃")').count() > 0) {
  await page.locator('button:has-text("放弃")').click();
}
// 编辑已发布章节：如弹"继续编辑"弹窗 → 点"继续编辑"
if (await page.locator('button:has-text("继续编辑")').count() > 0) {
  await page.locator('button:has-text("继续编辑")').click();
}
```

**第 1 步：填章节序号**
```js
// ⚠️ 必须用 focus() + keyboard.type，不能用 fill()
await page.evaluate(() => document.querySelector('input.serial-input')?.focus());
await page.keyboard.type('1');
await page.keyboard.press('Tab');
```

**第 2 步：填章节标题**
```js
await page.evaluate(() => document.querySelector('input.serial-editor-input-hint-area')?.focus());
await page.keyboard.type('章节标题');
await page.keyboard.press('Tab');
```

**第 3 步：填正文（见第二节🔴正文）**

**第 4 步：点"下一步" → 走发布流程**
```js
// 先检查"继续编辑"弹窗
if (await page.locator('button:has-text("继续编辑")').count() > 0) {
  await page.locator('button:has-text("继续编辑")').click();
  await page.waitForTimeout(1000);
}
await page.locator('button:has-text("下一步")').first().click({ force: true });
// 后续：分卷向导 → 风险检测弹窗(取消) → 发布设置(选AI=是) → 确认发布
```

---

## 二、踩坑清单（必看！）

### 🔴 正文填写问题（最大坑）

**❌ 以下方式全部无效：**
```js
navigator.clipboard.writeText(text) + Ctrl+V  // 无效
document.execCommand('insertText', ...)        // 返回 false
editor.fill(text)                              // ProseMirror 不是 input
editor.click() + keyboard.type()              // 字数仍为0
```

**✅ 唯一有效方式：JS定位光标到末尾 + 分批 keyboard.type**
```js
await page.evaluate(() => {
  const pm = document.querySelector('.syl-editor-container .ProseMirror');
  pm.focus();
  const sel = window.getSelection(), range = document.createRange();
  range.selectNodeContents(pm);
  range.collapse(false); // 光标移到末尾
  sel.removeAllRanges();
  sel.addRange(range);
});
for (let i = 0; i < content.length; i += 80) {
  await page.keyboard.type(content.slice(i, i + 80), { delay: 0 });
  await page.waitForTimeout(20);
}
```

**根本原因：** ProseMirror 第一个 `<p>` 内嵌 `contenteditable="false"` 的 widget，直接 click 光标落在 widget 上，键盘输入全被丢弃。

---

### 🔴 序号填写问题

**❌ fill() 无效**（React 检测到空值，报"章节序号只支持阿拉伯数字"）

**✅ focus() + keyboard.type()**

---

### 🔴 发布设置必须选"是否使用AI"

- 不选直接点"确认发布"：**弹窗关闭但章节数=0（静默失败）**
- 必须先选「是」再点确认发布

---

### 🟡 草稿弹窗

- **新建章节**：弹"有草稿，是否继续编辑？" → 点**放弃**
- **编辑已发布章节**：弹"有刚刚更新的章节，是否继续编辑？" → 点**继续编辑**
- `runPublishFlow` 内每轮循环也要检测此弹窗（点"下一步"后可能再次弹出）

---

### 🟡 分卷向导（每次发布都会出现）

- 点"下一步"后侧边弹出分卷向导，需连点两次"下一步"跳过

---

### 🟡 风险检测弹窗

- "是否进行内容风险检测？" → 点"取消"跳过，不影响发布

---

### 🟡 每次 goto 创建新 chapterId

- 必须在同一 browser session 内一次性完成填写+发布

---

## 三、登录方式

**❌ 无法自动登录**（headless UA 触发滑块验证码）

**✅ Cookie 方式：**
1. 真实浏览器登录 → DevTools → Application → Cookies → 复制全部
2. `node scripts/tomato.js set-cookies "<cookie>"`
3. 有效期约 60 天（sid_guard 字段为准）
4. 保存位置：`~/.tomato-writer-session.json`

---

## 四、保存草稿 API（备用）

```
POST /api/author/article/cover_article/v0/
book_id={bookId}&item_id={itemId}&title={title}&content={htmlContent}
```
- 只保存到服务端，不同步到浏览器 React state，**不能用于触发发布**

---

## 五、章节管理 DOM 参考

### 章节管理页结构（`/main/writer/chapter-manage/{bookId}`）

| 元素 | 选择器 |
|------|--------|
| 外层容器 | `.chapter` |
| 表格行 | `.arco-table-tr`（ArcoDesign 组件） |
| 章节预览链接 | `a[href*="/preview/"]` |
| 章节编辑链接 | `a[href*="/publish/"][href*="modifychapter"]` |
| chapterId 提取 | `editLink.href.match(/\/publish\/(\d{10,})\//)` |

**经验**：遇到选择器失效，优先用 `a[href]` 定位再 `.closest("tr")`，比猜 class 更稳定。

---

### E001｜list-chapters 返回空列表

**原因**：用了 `.chapter-list-item` / `.chapter-row` 等不存在的 class
**修复**：改为通过 `a[href*="/preview/"]` 定位行，再从 `td` 提取数据
**状态**：✅ 已修复（2026-03-13）

---

### F001｜page.evaluate 内禁用模板字符串插值

**症状**：`ReferenceError: xxx is not defined`

**原因**：`page.evaluate` 在浏览器上下文执行，模板字符串 `${cid}` 被浏览器解析失败

**❌ 错误写法：**
```js
page.evaluate((cid) => {
  document.querySelector(`a[href*="/publish/${cid}/"]`)
}, chapterId)
```

**✅ 正确写法：**
```js
page.evaluate((cid) => {
  const links = Array.from(document.querySelectorAll('a[href*="/publish/"]'));
  links.find(a => a.href.includes('/publish/' + cid + '/'));
}, chapterId)
```

**状态**：✅ 已记录（2026-03-13）

---

### P001｜"继续编辑"弹窗导致 edit-chapter 流程卡死

**症状**：`ok: false`，after 截图可见弹窗遮挡"下一步"，字数显示 0

**原因**：编辑已发布章节时平台弹"有刚刚更新的章节，是否继续编辑？"，脚本未处理

**修复**：`cmdEditChapter` 进入页面后检测并点"继续编辑"；`runPublishFlow` 每轮循环前也检测

**状态**：✅ 已修复（2026-03-13）
