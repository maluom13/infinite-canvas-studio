"""独立豆包登录：用单独的 Chrome 配置打开豆包，等用户登录成功后保存登录态。

只写自己的目录（DOUBAO_HOME，默认 D:/CodexData/.codex/infinite-canvas/doubao），
不读取、不写入 Muse 的任何账号或配置。
"""

import asyncio
import json
import os
import time
from pathlib import Path

from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright

ROOT = Path(os.environ.get("DOUBAO_HOME") or os.path.join(os.environ.get("CANVAS_DATA_ROOT", "D:/CodexData/.codex/infinite-canvas"), "doubao"))
PROFILE = ROOT / "profile"
SESSION = ROOT / "session.json"
STATUS = ROOT / "status.json"
LOGIN_URL = "https://www.doubao.com/chat/"
CDP = os.environ.get("DOUBAO_CDP", "http://127.0.0.1:19402")


def write_status(state: str, message: str) -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"state": state, "message": message, "at": int(time.time())}, ensure_ascii=False)
    temporary = ROOT / "status.tmp"
    temporary.write_text(payload, encoding="utf-8")
    os.replace(temporary, STATUS)


def has_session(cookies) -> bool:
    """豆包登录后会下发 sessionid；统一按域名和过期时间确认，避免把游客 Cookie 当登录。"""
    now = time.time()
    for cookie in cookies:
        if cookie.get("name") != "sessionid":
            continue
        if "doubao.com" not in str(cookie.get("domain", "")):
            continue
        expires = cookie.get("expires")
        if expires is None or expires < 0 or expires > now:
            return True
    return False


async def launch(p):
    try:
        return await p.chromium.launch_persistent_context(str(PROFILE), channel="chrome", headless=False, viewport=None)
    except Exception:
        return await p.chromium.launch_persistent_context(str(PROFILE), channel="msedge", headless=False, viewport=None)


async def open_context(p):
    """生成用的豆包浏览器已经开着时，直接复用它的窗口，避免同一配置被两个进程锁住。"""
    try:
        browser = await p.chromium.connect_over_cdp(CDP)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        return context, browser
    except Exception:
        return await launch(p), None


async def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    write_status("waiting", "请在弹出的窗口里登录豆包，检测到登录后窗口会自动关闭。")
    context = None
    browser = None
    try:
        async with async_playwright() as p:
            context, browser = await open_context(p)
            page = None
            for candidate in context.pages:
                if "doubao.com" in candidate.url:
                    page = candidate
                    break
            if page is None:
                page = context.pages[0] if context.pages else await context.new_page()
            await page.bring_to_front()
            try:
                await page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60000)
            except PlaywrightTimeoutError:
                write_status("waiting", "豆包页面加载较慢，请在窗口里刷新或直接完成登录。")
            deadline = time.time() + 900
            while time.time() < deadline:
                alive = [item for item in context.pages if not item.is_closed()]
                if not alive:
                    write_status("closed", "登录窗口已关闭，还没有完成登录。")
                    return
                if has_session(await context.cookies()):
                    await context.storage_state(path=str(SESSION))
                    write_status("done", "豆包登录成功。")
                    await asyncio.sleep(1.5)
                    if browser is not None:
                        await browser.close()
                    else:
                        await context.close()
                    return
                await asyncio.sleep(3)
            write_status("timeout", "等待登录超时，请重新点击「登录豆包」。")
            if browser is not None:
                await browser.close()
            else:
                await context.close()
    except Exception as error:  # noqa: BLE001 - 需要把真实原因回传给前端
        write_status("error", f"登录窗口启动失败：{error}")
        if context is not None:
            try:
                if browser is not None:
                    await browser.close()
                else:
                    await context.close()
            except Exception:
                pass
        raise


asyncio.run(main())
