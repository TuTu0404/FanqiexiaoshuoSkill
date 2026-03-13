---
name: tomato-writer
description: 番茄小说（fanqienovel.com）自动化发布 skill。当用户需要登录番茄小说、发布章节（章节标题+正文）、查看作品列表时使用。通过 Playwright 浏览器自动化实现，Cookie session 持久化免重复登录。
---

# tomato-writer

自动化操作番茄小说创作中心：保存 Cookie、查看作品、发布章节。

## 环境要求

- Node.js 16+
- Playwright（需先安装依赖，见下方安装流程）

---

## 安装流程

### 方案一：本地 / 有桌面环境（推荐）

适用于：Mac、Windows、有图形界面的 Linux

```bash
cd <skill目录>
npm install
npx playwright install chromium
```

安装完成后直接使用，Playwright 会调用本地 Chromium。

---

### 方案二：纯命令行 Linux 服务器

适用于：Ubuntu / Debian 无头服务器

```bash
cd <skill目录>
npm install

# 安装 Chromium 及系统依赖
npx playwright install chromium
npx playwright install-deps chromium
```

> `install-deps` 会自动安装 libglib、libnss 等底层系统库，缺少这些 Chromium 无法启动。
> 需要 sudo 权限，执行时可能提示输入密码。

## 快速开始

### 第一步：获取 Cookie（必须）

番茄小说有字节跳动滑块验证码，**无法自动登录**。必须手动在真实浏览器登录后导出 Cookie：

1. 在 Chrome/Edge 打开 `https://fanqienovel.com/main/writer/book-manage` 并登录
2. 打开 DevTools（F12）→ Application → Cookies → `fanqienovel.com`
3. 全选所有 Cookie → 复制（或用扩展 EditThisCookie 导出）
4. 执行保存命令：

```bash
node scripts/tomato.js set-cookies "<粘贴完整 cookie 字符串>"
```

Cookie 保存到 `~/.tomato-writer-session.json`，**有效期约 60 天**（以 `sid_guard` 字段到期时间为准）。

---

## 命令参考

### 保存 Cookie
```bash
node scripts/tomato.js set-cookies "<cookie-string>"
```

### 查看作品列表
```bash
node scripts/tomato.js list-books
```
返回作品 bookId 列表，发布章节时需要用到。

### 查看章节列表
```bash
node scripts/tomato.js list-chapters --book-id 7614138753522617369
```
返回所有章节的 ID、标题、字数、审核状态、发布时间。

### 查看章节详情
```bash
node scripts/tomato.js chapter-info \
  --book-id 7614138753522617369 \
  --chapter-id 7654321000000000001
```
返回单章的字数、标题、审核状态、发布时间。

### 修改章节内容
```bash
# 仅改标题
node scripts/tomato.js edit-chapter \
  --book-id 7614138753522617369 \
  --chapter-id 7654321000000000001 \
  --title "新章节标题"

# 仅改正文（从文件读取）
node scripts/tomato.js edit-chapter \
  --book-id 7614138753522617369 \
  --chapter-id 7654321000000000001 \
  --content-file /path/to/new-content.txt

# 标题 + 正文一起改
node scripts/tomato.js edit-chapter \
  --book-id 7614138753522617369 \
  --chapter-id 7654321000000000001 \
  --title "新标题" \
  --content-file /path/to/new-content.txt
```
修改后会重新走发布流程，状态变为**审核中**。

### 删除章节
```bash
node scripts/tomato.js delete-chapter \
  --book-id 7614138753522617369 \
  --chapter-id 7654321000000000001
```
⚠️ 删除不可恢复，请提前用 `list-chapters` 确认章节 ID。

---
```bash
# 正文直接传入
node scripts/tomato.js publish-chapter \
  --book-id 7614138753522617369 \
  --chapter-num 1 \
  --title "冰川融化，木筏开局" \
  --content "正文内容（不少于1000字）..."

# 正文从文件读取（推荐，避免命令行长度限制）
node scripts/tomato.js publish-chapter \
  --book-id 7614138753522617369 \
  --chapter-num 1 \
  --title "冰川融化，木筏开局" \
  --content-file /path/to/chapter.txt
```

**参数说明：**
| 参数 | 必填 | 说明 |
|------|------|------|
| `--book-id` | ✅ | 作品 ID（从 list-books 或 URL 获取） |
| `--chapter-num` | 否 | 章节序号，纯数字，默认 `1` |
| `--title` | ✅ | 章节标题 |
| `--content` | 二选一 | 正文内容字符串 |
| `--content-file` | 二选一 | 正文内容文件路径（txt） |

**正文要求：不少于 1000 字**（平台硬限制）

---

### 分卷管理

#### 查看所有分卷
```bash
node scripts/tomato.js list-volumes --book-id 7614138753522617369
```

#### 新建分卷
```bash
# ⚠️ 平台会自动拼「第N卷：」前缀，--name 只填冒号后的后缀
# 例：--name "冰川时代" → 实际保存为 "第二卷：冰川时代"
node scripts/tomato.js add-volume \
  --book-id 7614138753522617369 \
  --name "冰川时代"
```

#### 重命名分卷
```bash
# --volume-name 为当前完整分卷名，--new-name 为新后缀（平台会自动保留卷号前缀）
node scripts/tomato.js rename-volume \
  --book-id 7614138753522617369 \
  --volume-name "第二卷：冰川时代" \
  --new-name "觉醒时代"
```

#### 删除分卷
```bash
# ⚠️ 删除前确认分卷无章节，否则平台可能拒绝
node scripts/tomato.js delete-volume \
  --book-id 7614138753522617369 \
  --volume-name "第二卷：觉醒时代"
```

---

## 发布流程说明（内部 5 步弹窗）

每次发布会经过以下步骤（脚本自动处理）：

1. **填写表单** → 章节序号 + 标题 + 正文
2. **点"下一步"** → 触发分卷向导侧边栏
3. **分卷向导**（2步）→ 自动跳过
4. **风险检测弹窗** → 自动点"取消"跳过
5. **发布设置弹窗** → 自动选"是否使用AI = 否" → 点"确认发布"

发布成功后章节进入**审核中**状态，审核通过后正式上线。

---

## 调试

发布失败时查看截图定位问题：

```bash
# 发布前状态
open /tmp/tomato-before-publish.png

# 发布后状态
open /tmp/tomato-after-publish.png

# 字数不足错误
open /tmp/tomato-wc-error.png
```

详细踩坑记录见：[`references/publish-troubleshooting.md`](references/publish-troubleshooting.md)

---

## 常见错误

| 错误 | 原因 | 解决方案 |
|------|------|---------|
| `未找到 session` | 未执行 set-cookies | 重新获取 Cookie 执行 set-cookies |
| `Cookie 已过期` | sid_guard 已到期（约60天） | 重新获取 Cookie |
| `正文长度不足 1000 字` | 内容太短 | 补充内容到 1000 字以上 |
| `正文填写后字数不足` | 编辑器内容未正确写入 | 查看 /tmp/tomato-wc-error.png |
| 发布后章节数仍为 0 | 发布设置弹窗中未选"是否使用AI" | 脚本已自动处理，若仍失败查看截图 |

---

## 文件结构

```
tomato-writer/
├── SKILL.md                    # 本文档
├── scripts/
│   └── tomato.js              # 主脚本
├── references/
│   ├── api-notes.md           # DOM 选择器 & API 参考
│   └── publish-troubleshooting.md  # 完整踩坑文档（必读）
├── package.json
└── node_modules/              # 需执行 npm install 生成（未上传）
```
