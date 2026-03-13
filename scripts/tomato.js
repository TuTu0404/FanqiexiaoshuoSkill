#!/usr/bin/env node
/**
 * tomato-writer CLI — 番茄小说自动化发布工具
 *
 * 用法：
 *   node tomato.js set-cookies "<cookie-string>"
 *   node tomato.js list-books
 *   node tomato.js publish-chapter --book-id 123456 --chapter-num 1 --title "第一章 标题" --content "正文..."
 *   node tomato.js publish-chapter --book-id 123456 --chapter-num 1 --title "第一章 标题" --content-file /path/to/content.txt
 *   node tomato.js list-chapters  --book-id 123456
 *   node tomato.js chapter-info   --book-id 123456 --chapter-id 654321
 *   node tomato.js edit-chapter   --book-id 123456 --chapter-id 654321 --title "新标题" --content "新正文..."
 *   node tomato.js delete-chapter --book-id 123456 --chapter-id 654321
 *   node tomato.js list-volumes --book-id 123456
 *   node tomato.js add-volume --book-id 123456 --name "第二卷：新世界"
 *   node tomato.js rename-volume --book-id 123456 --volume-name "第一卷：默认" --new-name "第一卷：冰川时代"
 *   node tomato.js delete-volume --book-id 123456 --volume-name "第二卷：新世界"
 *
 * Auth session 保存到 ~/.tomato-writer-session.json
 * 获取 Cookie：浏览器登录番茄小说后，DevTools → Application → Cookies → 复制所有 Cookie
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSION_FILE = path.join(os.homedir(), '.tomato-writer-session.json');
const BASE_URL = 'https://fanqienovel.com';
const BOOK_MANAGE_URL = `${BASE_URL}/main/writer/book-manage`;

// ─── Cookie 工具 ────────────────────────────────────────────────

function parseCookieString(rawCookie) {
  return rawCookie.split(';').map(pair => {
    const [name, ...rest] = pair.trim().split('=');
    return {
      name: name.trim(),
      value: rest.join('=').trim(),
      domain: 'fanqienovel.com',
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'Lax'
    };
  }).filter(c => c.name && c.value);
}

function loadCookies() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).cookies || null;
  } catch (e) {
    return null;
  }
}

async function withAuth(fn) {
  const cookies = loadCookies();
  if (!cookies) {
    console.log(JSON.stringify({ ok: false, message: '未找到 session，请先执行 set-cookies 命令保存 Cookie' }));
    return;
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies(cookies);
  try {
    await fn(context);
  } finally {
    await browser.close();
  }
}

// ─── 填写编辑器工具函数 ──────────────────────────────────────────

/**
 * 填写 ProseMirror 富文本编辑器正文内容。
 *
 * 番茄小说编辑器特殊性：
 * 1. 第一个 <p> 内嵌了 contenteditable="false" 的 widget，直接 click 后
 *    keyboard.type 内容进不去（字数保持 0）
 * 2. 必须用 JS 把光标定位到编辑器末尾，再用 keyboard.type 分批输入
 * 3. clipboard 粘贴、execCommand、React nativeInputValueSetter 均无效
 */
async function fillEditor(page, content) {
  await page.evaluate(() => {
    const pm = document.querySelector('.syl-editor-container .ProseMirror');
    if (!pm) throw new Error('编辑器未找到');
    pm.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(pm);
    range.collapse(false); // 移到末尾
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.waitForTimeout(300);

  // 分批 80 字输入，避免超时
  const batchSize = 80;
  for (let i = 0; i < content.length; i += batchSize) {
    await page.keyboard.type(content.slice(i, i + batchSize), { delay: 0 });
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(2000);
}

/**
 * 读取页面正文字数（番茄显示格式为 "正文字数\n1052"）
 */
async function getWordCount(page) {
  return await page.evaluate(() => {
    const match = document.body.innerText.match(/正文字数\s*\n(\d+)/);
    return match ? parseInt(match[1]) : 0;
  });
}

// ─── 发布流程核心 ────────────────────────────────────────────────

/**
 * 走完「下一步 → 分卷向导 → 风险检测 → 发布设置 → 确认发布」完整流程。
 *
 * 流程说明（每次发布必经）：
 * Step 0: 点顶部"下一步"按钮
 * Step 1-2: 分卷向导侧边栏（内容大纲/人物卡片等），连点两次向导的"下一步"
 * Step 3: 风险检测弹窗 → 点"取消"跳过（不消耗使用次数）
 * Step 4: 发布设置弹窗 → 选"是否使用AI = 否" → 点"确认发布"
 *
 * ⚠️ 必须先选"是否使用AI"，否则点"确认发布"后章节不发布（静默失败，0章）
 */
async function runPublishFlow(page) {
  // 先点顶部"下一步"
  await page.locator('button:has-text("下一步")').first().click({ force: true, timeout: 8000 });
  await page.waitForTimeout(2500);

  let published = false;

  for (let step = 0; step < 12; step++) {
    const btns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button'))
        .filter(b => b.offsetParent !== null)
        .map(b => ({ t: b.innerText.trim(), d: b.disabled }))
        .filter(b => b.t)
    );
    const btnTexts = btns.map(b => b.t);
    console.error(`[flow step${step}] buttons: ${btnTexts.join(', ')}`);

    // 找到"确认发布"→ 先选 AI=是，再点发布
    const hasPub = btns.find(b => !b.d && ['确认发布', '立即发布', '发布'].includes(b.t));
    if (hasPub) {
      // 选"是"（AI生成）
      await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('.arco-radio, .arco-radio-wrapper, label, span'));
        for (const el of candidates) {
          if (el.innerText?.trim() === '是' && el.offsetParent !== null) {
            el.click();
            return;
          }
        }
      });
      await page.waitForTimeout(500);

      // 点确认发布
      await page.locator(`button:has-text("${hasPub.t}")`).first().click({ timeout: 8000 });
      await page.waitForTimeout(5000);
      published = true;
      break;
    }

    // 风险检测弹窗（"是否进行内容风险检测？"）→ 取消跳过
    if (btnTexts.includes('确定') && btnTexts.includes('取消') && !btnTexts.includes('确认发布')) {
      console.error('[flow] 跳过风险检测');
      await page.locator('button:has-text("取消")').last().click({ timeout: 5000 });
      await page.waitForTimeout(2000);
      continue;
    }

    // 其他情况：点最后一个"下一步" / "确定" / "我知道了"
    const nxt = btns.find(b => !b.d && ['下一步', '确定', '我知道了', '继续'].includes(b.t));
    if (nxt) {
      await page.locator(`button:has-text("${nxt.t}")`).last().click({ force: true, timeout: 5000 });
      await page.waitForTimeout(2000);
    } else {
      console.error('[flow] 没有可操作的按钮，停止');
      break;
    }
  }

  return published;
}

// ─── 命令实现 ────────────────────────────────────────────────────

async function cmdSetCookies(rawCookie) {
  const cookies = parseCookieString(rawCookie);
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ cookies }, null, 2));
  console.log(JSON.stringify({ ok: true, message: `Cookie 已保存，共 ${cookies.length} 个` }));
}

async function cmdListBooks() {
  await withAuth(async (context) => {
    const page = await context.newPage();
    await page.goto(BOOK_MANAGE_URL, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(2000);

    if (page.url().includes('login')) {
      console.log(JSON.stringify({ ok: false, message: 'Cookie 已过期，请重新执行 set-cookies' }));
      return;
    }

    const text = await page.evaluate(() => document.body.innerText);
    // 从页面文本提取作品信息（bookId 从 href 链接提取）
    const books = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      const seen = new Set();
      return links
        .map(a => {
          const m = a.href.match(/\/main\/writer\/(\d{15,})/);
          if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            return { bookId: m[1], href: a.href };
          }
          return null;
        })
        .filter(Boolean);
    });

    console.log(JSON.stringify({ ok: true, books, pageText: text.substring(0, 500) }));
  });
}

async function cmdPublishChapter(bookId, chapterNum, chapterTitle, content) {
  if (!content || content.trim().length < 1000) {
    console.log(JSON.stringify({
      ok: false,
      message: `正文长度不足 1000 字（当前 ${content?.trim().length || 0} 字），番茄小说平台要求最少 1000 字`
    }));
    return;
  }

  await withAuth(async (context) => {
    const page = await context.newPage();
    const publishUrl = `${BASE_URL}/main/writer/${bookId}/publish/?enter_from=newchapter_1`;

    await page.goto(publishUrl, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(2000);

    if (page.url().includes('login')) {
      console.log(JSON.stringify({ ok: false, message: 'Cookie 已过期，请重新执行 set-cookies' }));
      return;
    }

    // 移除引导弹窗
    await page.evaluate(() => { document.querySelector('#___reactour')?.remove(); });

    // 如有草稿弹窗（"是否继续编辑？"）→ 点"放弃"开新章节
    if (await page.locator('button:has-text("放弃")').count() > 0) {
      await page.locator('button:has-text("放弃")').click();
      await page.waitForTimeout(1000);
      console.error('[tomato] 已放弃旧草稿，开新章节');
    }
    await page.waitForTimeout(300);

    // 填章节序号（用 focus + keyboard.type，不能用 fill）
    await page.evaluate(() => { document.querySelector('input.serial-input')?.focus(); });
    await page.keyboard.type(String(chapterNum || '1'));
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    console.error(`[tomato] 章节序号: ${await page.locator('input.serial-input').first().inputValue()}`);

    // 填章节标题
    await page.evaluate(() => { document.querySelector('input.serial-editor-input-hint-area')?.focus(); });
    await page.keyboard.type(chapterTitle);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    console.error(`[tomato] 章节标题: ${await page.locator('input.serial-editor-input-hint-area').first().inputValue()}`);

    // 填正文（ProseMirror 专用方式）
    await fillEditor(page, content);
    const wc = await getWordCount(page);
    console.error(`[tomato] 正文字数: ${wc}`);

    if (wc < 1000) {
      await page.screenshot({ path: '/tmp/tomato-wc-error.png' });
      console.log(JSON.stringify({
        ok: false,
        message: `正文填写后字数不足 1000（实际 ${wc} 字），截图: /tmp/tomato-wc-error.png`
      }));
      return;
    }

    await page.screenshot({ path: '/tmp/tomato-before-publish.png' });

    // 走完发布流程（5步弹窗）
    const published = await runPublishFlow(page);
    await page.screenshot({ path: '/tmp/tomato-after-publish.png' });

    // 验证：访问作品管理页确认章节数量
    await page.goto(BOOK_MANAGE_URL, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1500);
    const bookText = await page.evaluate(() => document.body.innerText);
    const chapterCount = bookText.match(/(\d+)\s*章/)?.[1] || '未知';

    console.log(JSON.stringify({
      ok: published,
      message: published
        ? `章节「${chapterTitle}」已提交发布，当前章节数: ${chapterCount} 章，状态: 审核中`
        : `发布流程未完成，请查看截图 /tmp/tomato-after-publish.png`,
      bookId,
      chapterTitle,
      wordCount: wc
    }));
  });
}

// ─── 分卷管理（章节管理页）────────────────────────────────────────

/**
 * 打开章节管理页，点击「编辑分卷」，返回所有分卷弹窗引用
 */
async function openVolumeModal(page, bookId) {
  await page.goto(`${BASE_URL}/main/writer/chapter-manage/${bookId}`, { waitUntil: 'networkidle', timeout: 25000 });
  await page.waitForTimeout(2000);
  if (page.url().includes('login')) throw new Error('Cookie 已过期，请重新执行 set-cookies');
  await page.evaluate(() => document.querySelector('#___reactour')?.remove());
  if (await page.locator('button:has-text("我知道了")').count() > 0) {
    await page.locator('button:has-text("我知道了")').click();
    await page.waitForTimeout(500);
  }
  await page.locator('button:has-text("编辑分卷")').first().click();
  await page.waitForTimeout(1500);
}

/**
 * 从已打开的分卷弹窗中读取所有分卷名称
 */
async function getVolumeList(page) {
  return await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.chapter-volume-list-item'))
      .filter(el => el.offsetParent !== null)
      .map(el => {
        // 优先从「正常态」(.chapter-volume-list-item-normal) 读文字
        const normal = el.querySelector('.chapter-volume-list-item-normal span');
        return normal ? normal.innerText.trim() : el.innerText.trim().split('\n')[0];
      })
      .filter(Boolean);
  });
}

/**
 * 列出所有分卷
 */
async function cmdListVolumes(bookId) {
  await withAuth(async (context) => {
    const page = await context.newPage();
    await openVolumeModal(page, bookId);
    const volumes = await getVolumeList(page);
    console.log(JSON.stringify({ ok: true, bookId, volumes }));
  });
}

/**
 * 新建分卷
 * DOM：点「新建分卷」→ 最后一个 list-item 变为编辑态（有 input.serial-input）→ 填名字 → 点 .tomato-confirm
 *
 * ⚠️ 注意：平台会自动拼「第N卷：」前缀，--name 只需填冒号后的后缀
 * 例：--name "冰川时代" → 实际保存为 "第二卷：冰川时代"
 */
async function cmdAddVolume(bookId, volumeName) {
  if (!volumeName) { console.log(JSON.stringify({ ok: false, message: '缺少 --name 参数' })); return; }
  await withAuth(async (context) => {
    const page = await context.newPage();
    await openVolumeModal(page, bookId);

    const before = await getVolumeList(page);

    // 点「新建分卷」
    await page.locator('.chapter-volume-footer-add-volume').click();
    await page.waitForTimeout(800);

    // 在新出现的 input 里填名字
    const input = page.locator('.chapter-volume-list-item input.serial-input').last();
    await input.waitFor({ state: 'visible', timeout: 5000 });
    await input.fill(volumeName);
    await page.waitForTimeout(300);

    // 点确认（绿色勾）
    await page.locator('.chapter-volume-list-item .tomato-confirm').last().click();
    await page.waitForTimeout(1000);

    const after = await getVolumeList(page);
    const added = after.find(v => !before.includes(v));
    console.log(JSON.stringify({ ok: !!added, bookId, addedVolume: added || null, volumes: after }));
  });
}

/**
 * 重命名分卷
 * DOM：hover 分卷 item → 点 .tomato-edit → input 出现 → 清空填新名 → 点 .tomato-confirm
 */
async function cmdRenameVolume(bookId, volumeName, newName) {
  if (!volumeName || !newName) { console.log(JSON.stringify({ ok: false, message: '缺少 --volume-name 或 --new-name 参数' })); return; }
  await withAuth(async (context) => {
    const page = await context.newPage();
    await openVolumeModal(page, bookId);

    // 找到对应分卷
    const items = page.locator('.chapter-volume-list-item');
    const count = await items.count();
    let targetIdx = -1;
    for (let i = 0; i < count; i++) {
      const text = await items.nth(i).locator('.chapter-volume-list-item-normal span').textContent().catch(() => '');
      if (text.trim() === volumeName) { targetIdx = i; break; }
    }
    if (targetIdx < 0) {
      console.log(JSON.stringify({ ok: false, message: `未找到分卷「${volumeName}」` }));
      return;
    }

    // hover 触发图标显示
    await items.nth(targetIdx).hover();
    await page.waitForTimeout(300);
    // 点编辑图标
    await items.nth(targetIdx).locator('i.tomato-edit').click();
    await page.waitForTimeout(500);

    // 清空并填新名
    const input = items.nth(targetIdx).locator('input.serial-input');
    await input.waitFor({ state: 'visible', timeout: 5000 });
    await input.selectText();
    await input.fill(newName);
    await page.waitForTimeout(300);

    // 点确认
    await items.nth(targetIdx).locator('i.tomato-confirm').click();
    await page.waitForTimeout(1000);

    const after = await getVolumeList(page);
    // 平台保存时会拼前缀，检查 after 里是否包含 newName 作为后缀
    const success = after.some(v => v === newName || v.endsWith(newName) || v.includes(newName));
    console.log(JSON.stringify({ ok: success, bookId, renamed: newName, volumes: after }));
  });
}

/**
 * 删除分卷
 * DOM：hover → 点 .tomato-delete → 确认弹窗 → 点「确定」
 */
async function cmdDeleteVolume(bookId, volumeName) {
  if (!volumeName) { console.log(JSON.stringify({ ok: false, message: '缺少 --volume-name 参数' })); return; }
  await withAuth(async (context) => {
    const page = await context.newPage();
    await openVolumeModal(page, bookId);

    const items = page.locator('.chapter-volume-list-item');
    const count = await items.count();
    let targetIdx = -1;
    for (let i = 0; i < count; i++) {
      const text = await items.nth(i).locator('.chapter-volume-list-item-normal span').textContent().catch(() => '');
      if (text.trim() === volumeName) { targetIdx = i; break; }
    }
    if (targetIdx < 0) {
      console.log(JSON.stringify({ ok: false, message: `未找到分卷「${volumeName}」` }));
      return;
    }

    await items.nth(targetIdx).hover();
    await page.waitForTimeout(300);
    await items.nth(targetIdx).locator('i.tomato-delete').click();
    await page.waitForTimeout(1000);

    // 确认删除 popconfirm（按钮文字是「确认删除」）
    const confirmBtns = ['确认删除', '确定'];
    for (const txt of confirmBtns) {
      if (await page.locator(`.byte-popconfirm button:has-text("${txt}")`).count() > 0) {
        await page.locator(`.byte-popconfirm button:has-text("${txt}")`).click();
        await page.waitForTimeout(1000);
        break;
      }
    }

    const after = await getVolumeList(page);
    console.log(JSON.stringify({ ok: !after.includes(volumeName), bookId, deletedVolume: volumeName, volumes: after }));
  });
}

// ─── 章节管理 ────────────────────────────────────────────────────

/**
 * 列出作品所有章节（章节 ID、标题、字数、审核状态、发布时间）
 * 通过章节管理页 DOM 解析
 */
async function cmdListChapters(bookId) {
  await withAuth(async (context) => {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/main/writer/chapter-manage/${bookId}`, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(2000);

    if (page.url().includes('login')) {
      console.log(JSON.stringify({ ok: false, message: 'Cookie 已过期，请重新执行 set-cookies' }));
      return;
    }

    await page.evaluate(() => document.querySelector('#___reactour')?.remove());
    if (await page.locator('button:has-text("我知道了")').count() > 0) {
      await page.locator('button:has-text("我知道了")').click();
      await page.waitForTimeout(500);
    }

    const chapters = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.chapter-list-item, .chapter-item, [class*="chapter-row"]'))
        .filter(el => el.offsetParent !== null)
        .map(el => {
          // 提取章节 ID（从编辑链接 href 中）
          const editLink = el.querySelector('a[href*="/publish/"]') || el.querySelector('a[href*="/edit/"]');
          const chapterIdMatch = editLink?.href.match(/\/(\d{10,})\/?/);
          const chapterId = chapterIdMatch?.[1] || null;

          // 提取标题
          const titleEl = el.querySelector('.chapter-title, [class*="title"]');
          const title = titleEl?.innerText?.trim() || '';

          // 提取字数
          const wcMatch = el.innerText.match(/(\d+)\s*字/);
          const wordCount = wcMatch ? parseInt(wcMatch[1]) : null;

          // 提取审核状态（审核中 / 已发布 / 未发布 / 审核失败 等）
          const statusEl = el.querySelector('[class*="status"], [class*="state"]');
          const status = statusEl?.innerText?.trim() || '';

          // 提取发布时间
          const timeMatch = el.innerText.match(/(\d{4}[-/]\d{2}[-/]\d{2}[\s\d:]*)/);
          const publishTime = timeMatch?.[1]?.trim() || null;

          return { chapterId, title, wordCount, status, publishTime };
        })
        .filter(c => c.title);
    });

    console.log(JSON.stringify({ ok: true, bookId, total: chapters.length, chapters }));
  });
}

/**
 * 查看单章详情（字数、标题、审核状态、发布时间）
 * 直接访问章节编辑页读取信息
 */
async function cmdChapterInfo(bookId, chapterId) {
  await withAuth(async (context) => {
    const page = await context.newPage();
    // 先从章节列表页获取该章详情
    await page.goto(`${BASE_URL}/main/writer/chapter-manage/${bookId}`, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(2000);

    if (page.url().includes('login')) {
      console.log(JSON.stringify({ ok: false, message: 'Cookie 已过期，请重新执行 set-cookies' }));
      return;
    }

    await page.evaluate(() => document.querySelector('#___reactour')?.remove());
    if (await page.locator('button:has-text("我知道了")').count() > 0) {
      await page.locator('button:has-text("我知道了")').click();
      await page.waitForTimeout(500);
    }

    const info = await page.evaluate((cid) => {
      const rows = Array.from(document.querySelectorAll('.chapter-list-item, .chapter-item, [class*="chapter-row"]'))
        .filter(el => el.offsetParent !== null);
      for (const el of rows) {
        const editLink = el.querySelector('a[href*="/publish/"]') || el.querySelector('a[href*="/edit/"]');
        const m = editLink?.href.match(/\/(\d{10,})\/?/);
        if (m?.[1] === cid) {
          const title = el.querySelector('.chapter-title, [class*="title"]')?.innerText?.trim() || '';
          const wcMatch = el.innerText.match(/(\d+)\s*字/);
          const wordCount = wcMatch ? parseInt(wcMatch[1]) : null;
          const statusEl = el.querySelector('[class*="status"], [class*="state"]');
          const status = statusEl?.innerText?.trim() || '';
          const timeMatch = el.innerText.match(/(\d{4}[-/]\d{2}[-/]\d{2}[\s\d:]*)/);
          const publishTime = timeMatch?.[1]?.trim() || null;
          return { chapterId: cid, title, wordCount, status, publishTime };
        }
      }
      return null;
    }, chapterId);

    if (!info) {
      console.log(JSON.stringify({ ok: false, message: `未找到章节 ID: ${chapterId}，请先用 list-chapters 确认 ID` }));
      return;
    }
    console.log(JSON.stringify({ ok: true, bookId, ...info }));
  });
}

/**
 * 修改章节内容（标题 + 正文）
 * 打开章节编辑页 → 修改标题 → 清空正文重新填写 → 走发布流程
 */
async function cmdEditChapter(bookId, chapterId, newTitle, newContent) {
  if (!chapterId) { console.log(JSON.stringify({ ok: false, message: '缺少 --chapter-id' })); return; }
  if (!newTitle && !newContent) { console.log(JSON.stringify({ ok: false, message: '至少提供 --title 或 --content 其中一个' })); return; }
  if (newContent && newContent.trim().length < 1000) {
    console.log(JSON.stringify({ ok: false, message: `正文长度不足 1000 字（当前 ${newContent.trim().length} 字）` }));
    return;
  }

  await withAuth(async (context) => {
    const page = await context.newPage();
    const editUrl = `${BASE_URL}/main/writer/${bookId}/publish/${chapterId}`;
    await page.goto(editUrl, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(2000);

    if (page.url().includes('login')) {
      console.log(JSON.stringify({ ok: false, message: 'Cookie 已过期，请重新执行 set-cookies' }));
      return;
    }

    await page.evaluate(() => document.querySelector('#___reactour')?.remove());

    // 修改标题
    if (newTitle) {
      const titleInput = page.locator('input.serial-editor-input-hint-area').first();
      await titleInput.waitFor({ state: 'visible', timeout: 8000 });
      await titleInput.selectText();
      await page.keyboard.type(newTitle);
      await page.keyboard.press('Tab');
      await page.waitForTimeout(300);
      console.error(`[edit] 标题已改为: ${newTitle}`);
    }

    // 修改正文
    if (newContent) {
      // 清空编辑器
      await page.evaluate(() => {
        const pm = document.querySelector('.syl-editor-container .ProseMirror');
        if (!pm) throw new Error('编辑器未找到');
        pm.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(pm);
        sel.removeAllRanges();
        sel.addRange(range);
      });
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(500);

      await fillEditor(page, newContent);
      const wc = await getWordCount(page);
      console.error(`[edit] 正文字数: ${wc}`);

      if (wc < 1000) {
        await page.screenshot({ path: '/tmp/tomato-edit-wc-error.png' });
        console.log(JSON.stringify({ ok: false, message: `正文填写后字数不足 1000（实际 ${wc} 字）` }));
        return;
      }
    }

    await page.screenshot({ path: '/tmp/tomato-before-edit-publish.png' });
    const published = await runPublishFlow(page);
    await page.screenshot({ path: '/tmp/tomato-after-edit-publish.png' });

    console.log(JSON.stringify({
      ok: published,
      message: published
        ? `章节 ${chapterId} 修改已提交，状态: 审核中`
        : `修改流程未完成，请查看截图 /tmp/tomato-after-edit-publish.png`,
      bookId,
      chapterId
    }));
  });
}

/**
 * 删除章节
 * 章节管理页 → 找到目标章节 → 点删除图标 → 确认弹窗
 */
async function cmdDeleteChapter(bookId, chapterId) {
  if (!chapterId) { console.log(JSON.stringify({ ok: false, message: '缺少 --chapter-id' })); return; }

  await withAuth(async (context) => {
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/main/writer/chapter-manage/${bookId}`, { waitUntil: 'networkidle', timeout: 25000 });
    await page.waitForTimeout(2000);

    if (page.url().includes('login')) {
      console.log(JSON.stringify({ ok: false, message: 'Cookie 已过期，请重新执行 set-cookies' }));
      return;
    }

    await page.evaluate(() => document.querySelector('#___reactour')?.remove());
    if (await page.locator('button:has-text("我知道了")').count() > 0) {
      await page.locator('button:has-text("我知道了")').click();
      await page.waitForTimeout(500);
    }

    // 找到对应章节行
    const rows = page.locator('.chapter-list-item, .chapter-item, [class*="chapter-row"]');
    const count = await rows.count();
    let targetIdx = -1;
    for (let i = 0; i < count; i++) {
      const el = rows.nth(i);
      const editLink = await el.locator('a[href*="/publish/"], a[href*="/edit/"]').first().getAttribute('href').catch(() => '');
      if (editLink?.includes(chapterId)) { targetIdx = i; break; }
    }

    if (targetIdx < 0) {
      console.log(JSON.stringify({ ok: false, message: `未找到章节 ID: ${chapterId}，请先用 list-chapters 确认 ID` }));
      return;
    }

    // hover 触发操作图标
    await rows.nth(targetIdx).hover();
    await page.waitForTimeout(300);

    // 点删除图标
    const deleteBtn = rows.nth(targetIdx).locator('i[class*="delete"], button[class*="delete"], [class*="delete-btn"]').first();
    await deleteBtn.click({ timeout: 5000 });
    await page.waitForTimeout(1000);

    // 确认删除弹窗
    const confirmTexts = ['确认删除', '确定', '删除'];
    for (const txt of confirmTexts) {
      const btn = page.locator(`.arco-popconfirm button:has-text("${txt}"), .byte-popconfirm button:has-text("${txt}"), .arco-modal-footer button:has-text("${txt}")`);
      if (await btn.count() > 0) {
        await btn.first().click({ timeout: 5000 });
        await page.waitForTimeout(1500);
        break;
      }
    }

    // 验证是否已删除
    const remaining = await page.evaluate((cid) => {
      return Array.from(document.querySelectorAll('a[href*="/publish/"], a[href*="/edit/"]'))
        .some(a => a.href.includes(cid));
    }, chapterId);

    console.log(JSON.stringify({
      ok: !remaining,
      message: !remaining ? `章节 ${chapterId} 已删除` : `删除可能未成功，请检查页面`,
      bookId,
      chapterId
    }));
  });
}



function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      result[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
      if (result[key] !== true) i++;
    }
  }
  return result;
}

const [,, cmd, ...rawArgs] = process.argv;
const args = parseArgs(rawArgs);

(async () => {
  switch (cmd) {
    case 'set-cookies': {
      const raw = rawArgs[0];
      if (!raw || raw.startsWith('--')) {
        console.log(JSON.stringify({ ok: false, message: '用法: set-cookies "<完整cookie字符串>"' }));
        process.exit(1);
      }
      await cmdSetCookies(raw);
      break;
    }

    case 'list-books':
      await cmdListBooks();
      break;

    case 'publish-chapter': {
      if (!args.bookId || !args.title) {
        console.log(JSON.stringify({ ok: false, message: '缺少必要参数: --book-id <id> --title <章节标题> [--chapter-num <序号>] (--content <正文> | --content-file <路径>)' }));
        process.exit(1);
      }
      let content = args.content || '';
      if (args.contentFile) {
        content = fs.readFileSync(args.contentFile, 'utf8');
      }
      if (!content) {
        console.log(JSON.stringify({ ok: false, message: '缺少正文: 使用 --content 或 --content-file' }));
        process.exit(1);
      }
      await cmdPublishChapter(args.bookId, args.chapterNum || '1', args.title, content);
      break;
    }

    case 'list-chapters':
      if (!args.bookId) { console.log(JSON.stringify({ ok: false, message: '缺少 --book-id' })); process.exit(1); }
      await cmdListChapters(args.bookId);
      break;

    case 'chapter-info':
      if (!args.bookId || !args.chapterId) { console.log(JSON.stringify({ ok: false, message: '缺少 --book-id 或 --chapter-id' })); process.exit(1); }
      await cmdChapterInfo(args.bookId, args.chapterId);
      break;

    case 'edit-chapter': {
      if (!args.bookId || !args.chapterId) { console.log(JSON.stringify({ ok: false, message: '缺少 --book-id 或 --chapter-id' })); process.exit(1); }
      let editContent = args.content || '';
      if (args.contentFile) editContent = fs.readFileSync(args.contentFile, 'utf8');
      await cmdEditChapter(args.bookId, args.chapterId, args.title || null, editContent || null);
      break;
    }

    case 'delete-chapter':
      if (!args.bookId || !args.chapterId) { console.log(JSON.stringify({ ok: false, message: '缺少 --book-id 或 --chapter-id' })); process.exit(1); }
      await cmdDeleteChapter(args.bookId, args.chapterId);
      break;

    case 'list-volumes':
      if (!args.bookId) { console.log(JSON.stringify({ ok: false, message: '缺少 --book-id' })); process.exit(1); }
      await cmdListVolumes(args.bookId);
      break;

    case 'add-volume':
      if (!args.bookId || !args.name) { console.log(JSON.stringify({ ok: false, message: '缺少 --book-id 或 --name' })); process.exit(1); }
      await cmdAddVolume(args.bookId, args.name);
      break;

    case 'rename-volume':
      if (!args.bookId || !args.volumeName || !args.newName) { console.log(JSON.stringify({ ok: false, message: '缺少 --book-id, --volume-name 或 --new-name' })); process.exit(1); }
      await cmdRenameVolume(args.bookId, args.volumeName, args.newName);
      break;

    case 'delete-volume':
      if (!args.bookId || !args.volumeName) { console.log(JSON.stringify({ ok: false, message: '缺少 --book-id 或 --volume-name' })); process.exit(1); }
      await cmdDeleteVolume(args.bookId, args.volumeName);
      break;

    default:
      console.log(JSON.stringify({
        ok: false,
        message: [
          '可用命令:',
          '  set-cookies      "<cookie>"',
          '  list-books',
          '  publish-chapter  --book-id <id> --chapter-num <n> --title <标题> (--content <正文> | --content-file <路径>)',
          '  list-chapters    --book-id <id>',
          '  chapter-info     --book-id <id> --chapter-id <id>',
          '  edit-chapter     --book-id <id> --chapter-id <id> [--title <新标题>] [--content <正文> | --content-file <路径>]',
          '  delete-chapter   --book-id <id> --chapter-id <id>',
          '  list-volumes     --book-id <id>',
          '  add-volume       --book-id <id> --name <分卷名>',
          '  rename-volume    --book-id <id> --volume-name <旧名> --new-name <新名>',
          '  delete-volume    --book-id <id> --volume-name <分卷名>',
        ].join('\n')
      }));
      process.exit(1);
  }
})();
