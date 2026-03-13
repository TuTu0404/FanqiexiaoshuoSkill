---
name: tomato-writer
description: 番茄小说（fanqienovel.com）自动化发布 skill。当用户需要操作番茄小说创作中心时优先使用，包括：发布章节、修改章节标题或正文、删除章节、查看章节列表、章节详情、查看/新建/重命名/删除分卷、查看作品列表、保存登录 Cookie 等。通过 Playwright 浏览器自动化实现，Cookie session 持久化免重复登录。只要用户提到番茄小说、发章节、改正文、分卷管理等创作相关操作，就应优先调用本 skill。
---

# tomato-writer

自动化操作番茄小说创作中心：保存 Cookie、查看作品、发布 / 修改 / 删除章节、管理分卷。

---

## Agent 使用流程

收到用户请求时，按以下路径决策：

**1. 首次使用 / Cookie 过期**
- `~/.tomato-writer-session.json` 不存在，或运行命令后提示「Cookie 已过期」
- → 引导用户走「快速开始」流程重新获取 Cookie

**2. 发布新章节**
- 若用户已知 bookId → 直接 `publish-chapter`
- 若不知道 bookId → 先 `list-books` 获取，再 `publish-chapter`
- 正文内容先用 `write_file` 工具写入 `/tmp/tomato-content.txt`，再用 `--content-file /tmp/tomato-content.txt` 传入（避免命令行长度限制导致内容截断）

**3. 修改章节标题 / 正文**
- 先 `list-chapters --book-id <id>` 获取章节列表（含 chapterId）
- 再 `edit-chapter --book-id <id> --chapter-id <id> --title / --content-file`
- 正文修改同样先用 `write_file` 写入 `/tmp/tomato-content.txt`，再用 `--content-file` 传入

**4. 删除章节**
- 先 `list-chapters` 确认 chapterId（删除不可恢复）
- 再 `delete-chapter`

**5. 分卷管理**
- 先 `list-volumes` 查看现有分卷
- 再按需 `add-volume` / `rename-volume` / `delete-volume`

---

## 安装流程

适用所有环境（本地 / 服务器通用）：

```bash
cd <skill目录>
npm install
npx playwright install chromium
```

**仅无头 Linux 服务器需额外执行：**
```bash
# 安装 Chromium 底层系统依赖（需 sudo）
npx playwright install-deps chromium
```

> 缺少此步会报 `libglib` / `libnss` 等错误，Chromium 无法启动。

---

## 快速开始

### 获取 Cookie（必须，首次使用）

番茄小说有字节跳动滑块验证码，**无法自动登录**，需手动导出 Cookie：

1. Chrome/Edge 打开 `https://fanqienovel.com/main/writer/book-manage` 并登录
2. DevTools（F12）→ Application → Cookies → `fanqienovel.com`
3. 全选复制所有 Cookie（或用 EditThisCookie 扩展导出）
4. 执行：

```bash
node scripts/tomato.js set-cookies "<粘贴完整 cookie 字符串>"
```

Cookie 保存到 `~/.tomato-writer-session.json`，**有效期约 60 天**（`sid_guard` 字段为准）。

---

## 命令参考

### 查看作品列表
```bash
node scripts/tomato.js list-books
```

### 查看章节列表
```bash
node scripts/tomato.js list-chapters --book-id <bookId>
```
返回：章节标题列表（含序号）。需要详细信息用 `chapter-info`。

### 查看章节详情
```bash
node scripts/tomato.js chapter-info \
  --book-id <bookId> \
  --chapter-id <chapterId>
```
返回：标题、章节ID、字数、审核状态、发布时间。

### 发布章节
```bash
# 推荐：正文从文件读取（避免命令行长度限制）
node scripts/tomato.js publish-chapter \
  --book-id <bookId> \
  --chapter-num 1 \
  --title "章节标题" \
  --content-file /tmp/chapter.txt

# 也可直接传入字符串（短内容）
node scripts/tomato.js publish-chapter \
  --book-id <bookId> \
  --chapter-num 1 \
  --title "章节标题" \
  --content "正文内容（不少于1000字）..."
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--book-id` | ✅ | 作品 ID（从 list-books 或 URL 获取） |
| `--chapter-num` | 否 | 章节序号，纯数字，默认 `1` |
| `--title` | ✅ | 章节标题 |
| `--content` | 二选一 | 正文字符串 |
| `--content-file` | 二选一 | 正文文件路径（txt，**推荐**） |

> ⚠️ **正文要求：不少于 1000 字**（平台硬限制）

### 修改章节内容
```bash
# 仅改标题
node scripts/tomato.js edit-chapter \
  --book-id <bookId> --chapter-id <chapterId> \
  --title "新标题"

# 仅改正文（先将内容写入临时文件）
node scripts/tomato.js edit-chapter \
  --book-id <bookId> --chapter-id <chapterId> \
  --content-file /tmp/new-content.txt

# 标题 + 正文一起改
node scripts/tomato.js edit-chapter \
  --book-id <bookId> --chapter-id <chapterId> \
  --title "新标题" --content-file /tmp/new-content.txt
```
> 修改后重新走发布流程，状态变为**审核中**。

### 删除章节
```bash
node scripts/tomato.js delete-chapter \
  --book-id <bookId> \
  --chapter-id <chapterId>
```
> ⚠️ 删除不可恢复，先用 `list-chapters` 确认 chapterId。

### 分卷管理
```bash
# 查看分卷
node scripts/tomato.js list-volumes --book-id <bookId>

# 新建分卷（--name 只填卷名后缀，平台自动加「第N卷：」前缀）
node scripts/tomato.js add-volume --book-id <bookId> --name "冰川时代"

# 重命名（--volume-name 为完整名称，--new-name 为新后缀）
node scripts/tomato.js rename-volume \
  --book-id <bookId> \
  --volume-name "第二卷：冰川时代" \
  --new-name "觉醒时代"

# 删除（确保分卷内无章节）
node scripts/tomato.js delete-volume \
  --book-id <bookId> \
  --volume-name "第二卷：觉醒时代"
```

---

## 发布流程说明（内部 5 步弹窗）

每次发布 / 修改章节，脚本自动处理以下流程：

1. **填写表单** → 章节序号 + 标题 + 正文
2. **点"下一步"** → 触发分卷向导侧边栏
3. **分卷向导**（2步）→ 自动跳过
4. **风险检测弹窗** → 自动点"取消"跳过
5. **发布设置弹窗** → 自动选「是否使用AI = **是**」→ 点"确认发布"

发布成功后章节进入**审核中**状态，审核通过后正式上线。

---

## 常见错误

| 错误 | 原因 | 解决方案 |
|------|------|---------|
| `未找到 session` | 未执行 set-cookies | 重新获取 Cookie |
| `Cookie 已过期` | sid_guard 到期（约60天） | 重新获取 Cookie |
| `正文长度不足 1000 字` | 内容太短 | 补充内容到 1000 字以上 |
| `正文填写后字数不足` | 编辑器内容未正确写入 | 查看 `/tmp/tomato-wc-error.png` |
| 发布后章节数仍为 0 | 发布设置弹窗未正确处理 | 查看 `/tmp/tomato-after-publish.png` |

详细踩坑记录：[`references/publish-troubleshooting.md`](references/publish-troubleshooting.md)

---

## 文件结构

```
tomato-writer/
├── SKILL.md                         # 本文档（AI 执行入口）
├── scripts/
│   └── tomato.js                   # 主脚本
├── references/
│   ├── publish-troubleshooting.md  # 踩坑记录（分级索引）
│   └── api-notes.md                # DOM 选择器 & API 参考
├── package.json
└── node_modules/                   # npm install 生成（未上传）
```
