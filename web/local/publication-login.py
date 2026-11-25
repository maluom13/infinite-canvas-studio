import asyncio, json, os, sys
from pathlib import Path
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError

ROOT = Path(os.environ.get("PUBLISHER_HOME") or os.path.join(os.environ.get("CANVAS_DATA_ROOT", "D:/CodexData/.codex/infinite-canvas"), "publisher")) / "accounts"
URLS = {
    'douyin': 'https://creator.douyin.com/creator-micro/home',
    'kuaishou': 'https://cp.kuaishou.com/article/publish/video',
    'tencent': 'https://channels.weixin.qq.com/platform/post/create',
}

async def main(platform):
    if platform not in URLS:
        raise ValueError('Unsupported platform')
    directory = ROOT / platform
    directory.mkdir(parents=True, exist_ok=True)
    def status(state, message):
        temporary = directory / 'status.tmp'
        temporary.write_text(json.dumps({'state': state, 'message': message}, ensure_ascii=False), encoding='utf-8')
        os.replace(temporary, directory / 'status.json')
    status('waiting', '请在独立浏览器窗口扫码登录，完成后点击画布中的刷新状态。')
    try:
        async with async_playwright() as p:
            context = await p.chromium.launch_persistent_context(str(directory / 'browser-edge'), channel='msedge', headless=False)
            page = context.pages[0] if context.pages else await context.new_page()
            await page.bring_to_front()
            try:
                await page.goto(URLS[platform], wait_until='domcontentloaded')
            except PlaywrightTimeoutError:
                status('waiting', '创作者页面加载较慢，登录窗口已保留，请在窗口中刷新或完成登录。')
            await page.screenshot(path=str(directory / 'login-preview.png'))
            # No stealth, captcha solving, or publishing. Persist only this isolated profile.
            while context.pages:
                # Creator navigation may open a new tab; observe only this isolated context.
                for candidate in context.pages:
                    if not candidate.is_closed() and candidate.url.startswith(URLS[platform].split('/')[0] + '//' + URLS[platform].split('/')[2]):
                        page = candidate
                if page.is_closed():
                    await asyncio.sleep(2.5)
                    continue
                if platform == 'douyin' and '/creator-micro/home' in page.url:
                    upload_link = page.locator('a[href*="/creator-micro/content/upload"]').first
                    if await upload_link.count() and await upload_link.is_visible():
                        await upload_link.click()
                if await page.locator('input[type="file"]').count() and page.url.startswith(URLS[platform].split('/')[0] + '//' + URLS[platform].split('/')[2]):
                    status('upload_page_ready', '已打开上传页面。登录会话已保存在本机，实际账号及发布能力仍需核对。')
                    await context.storage_state(path=str(directory / 'session.json'))
                    await context.close()
                    return
                await asyncio.sleep(2.5)
            status('closed', '登录窗口已关闭，尚未确认上传页面。')
    except Exception:
        status('error', '登录浏览器未能完成连接，请重新登录或检查本机 Edge。')
        raise

asyncio.run(main(sys.argv[1]))
