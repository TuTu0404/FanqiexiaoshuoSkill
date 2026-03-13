# tomato-writer

番茄小说创作中心自动化工具，基于 Playwright 浏览器自动化实现。

## 功能

- 发布章节（支持 1000 字以上正文）
- 修改章节标题 / 正文
- 删除章节
- 查看章节列表 / 章节详情
- 分卷管理（新建 / 重命名 / 删除）
- Cookie session 持久化（有效期约 60 天）

## 安装

```bash
npm install
npx playwright install chromium

# 仅无头 Linux 服务器需额外执行：
npx playwright install-deps chromium
```

## 使用

首次使用需手动获取 Cookie（平台有滑块验证码，无法自动登录）：

```bash
node scripts/tomato.js set-cookies "<cookie-string>"
```

之后直接使用各命令：

```bash
node scripts/tomato.js list-books
node scripts/tomato.js list-chapters --book-id <bookId>
node scripts/tomato.js publish-chapter --book-id <bookId> --title "标题" --content-file /path/to/content.txt
```

完整命令说明见 [SKILL.md](SKILL.md)，踩坑记录见 [references/publish-troubleshooting.md](references/publish-troubleshooting.md)。

## 环境要求

- Node.js 16+
- Playwright 1.x
