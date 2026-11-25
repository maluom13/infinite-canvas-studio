"""独立豆包生成：连接常驻的豆包浏览器窗口，走网页自动生成图片或视频。

- 浏览器由画布桥接启动并保持打开（见 doubao-bridge.ts），登录态在 doubao/profile；
- 遇到豆包人机验证时把状态写成 verify，等用户在窗口里完成后自动继续；
- 只写自己的 jobs/<id>.json 与 media/，不碰 Muse。
"""

import argparse
import asyncio
import base64
import json
import os
import re
import time
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(os.environ.get("DOUBAO_HOME") or os.path.join(os.environ.get("CANVAS_DATA_ROOT", "D:/CodexData/.codex/infinite-canvas"), "doubao"))
JOBS = ROOT / "jobs"
MEDIA = ROOT / "media"
CDP = os.environ.get("DOUBAO_CDP", "http://127.0.0.1:19402")
CHAT_URL = "https://www.doubao.com/chat/"
CAPTCHA_HINT = "请选择所有符合上文描述的图片"
ERROR_HINTS = ("服务访问频繁", "访问过于频繁", "请求过于频繁", "今日生成次数", "生成失败", "内容不合规")


def write_job(job_id: str, **fields) -> None:
    JOBS.mkdir(parents=True, exist_ok=True)
    path = JOBS / f"{job_id}.json"
    current = {}
    if path.exists():
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            current = {}
    current.update(fields)
    current["updatedAt"] = int(time.time())
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(current, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


async def open_chat(context):
    page = None
    for candidate in context.pages:
        if "doubao.com" in candidate.url:
            page = candidate
            break
    if page is None:
        page = await context.new_page()
    await page.bring_to_front()
    # 每次回到空白对话页：技能入口（图像生成/视频生成）只在首页出现，历史会话里没有
    await page.goto(CHAT_URL, wait_until="domcontentloaded", timeout=60000)
    await page.wait_for_timeout(1500)
    return page


async def collect_media(page):
    """返回页面上非图标、非弹窗内的图片/视频。"""
    return await page.evaluate(
        """() => {
            const inModal = (el) => Boolean(el.closest('[role="dialog"], .dbd-modal, [class*="modal"]'));
            const images = [...document.querySelectorAll('img')]
                .filter((img) => (img.naturalWidth || 0) >= 300 && !inModal(img) && !/icon|avatar|emoji/i.test(img.src))
                .map((img) => img.currentSrc || img.src)
                .filter(Boolean);
            const videos = [...document.querySelectorAll('video')]
                .filter((video) => !inModal(video))
                .map((video) => video.currentSrc || video.src || video.querySelector('source')?.src)
                .filter(Boolean);
            return { images: images.slice(-6), videos: videos.slice(-3), text: document.body.innerText.slice(-400) };
        }"""
    )


async def find_video_src(context):
    """视频卡片要先点开才有 <video>；可能开在新标签页，所以遍历所有页面。"""
    for candidate in reversed(context.pages):
        try:
            values = await candidate.evaluate(
                "[...document.querySelectorAll('video')].map(v => v.currentSrc || v.src).filter(Boolean)"
            )
        except Exception:
            values = []
        if values:
            return values[-1]
    return None


async def open_video_card(page, context):
    card = page.locator('[class*="block-video"]').last
    if await card.count() == 0:
        return None
    try:
        await card.locator("img").first.click(force=True)
    except Exception:
        try:
            await card.click(force=True)
        except Exception:
            return None
    for _ in range(15):
        await asyncio.sleep(2)
        source = await find_video_src(context)
        if source:
            return source
    return None


async def save_media(context, url: str, target: Path) -> None:
    if url.startswith("data:"):
        header, _, payload = url.partition(",")
        if ";base64" in header:
            target.write_bytes(base64.b64decode(payload))
        else:
            import urllib.parse

            target.write_bytes(urllib.parse.unquote_to_bytes(payload))
        return
    if url.startswith("blob:"):
        # blob: 只能页面内读，转成 base64 再落盘
        data = await context.pages[0].evaluate(
            """async (src) => {
                const response = await fetch(src);
                const buffer = await response.arrayBuffer();
                let binary = '';
                const bytes = new Uint8Array(buffer);
                for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
                return btoa(binary);
            }""",
            url,
        )
        target.write_bytes(base64.b64decode(data))
        return
    response = await context.request.get(url, timeout=120000)
    if not response.ok:
        raise RuntimeError(f"下载生成结果失败（HTTP {response.status}）")
    target.write_bytes(await response.body())


def guess_ext(url: str, fallback: str) -> str:
    match = re.search(r"\.(png|jpe?g|webp|mp4)(?:\?|~|$)", url, re.I)
    if match:
        ext = match.group(1).lower()
        return "jpg" if ext == "jpeg" else ext
    return fallback


def sniff_ext(path: Path) -> str:
    """按文件头纠正扩展名，避免把 webp/jpg 存成 .png 后浏览器解不出来。"""
    try:
        head = path.read_bytes()[:16]
    except Exception:
        return ""
    if head.startswith(b"\x89PNG"):
        return "png"
    if head.startswith(b"\xff\xd8"):
        return "jpg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if len(head) >= 12 and head[4:8] == b"ftyp":
        return "mp4"
    return ""


async def run(args) -> None:
    JOBS.mkdir(parents=True, exist_ok=True)
    MEDIA.mkdir(parents=True, exist_ok=True)
    write_job(args.job, status="running", message="正在打开豆包…")
    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp(CDP)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        page = await open_chat(context)
        skill = "图像生成" if args.kind == "image" else "视频生成"
        chip = page.get_by_text(skill, exact=True).first
        await chip.wait_for(state="visible", timeout=25000)
        await chip.click()
        await page.wait_for_timeout(1500)
        before = await collect_media(page)
        before_set = set(before["images"]) | set(before["videos"])
        box = page.locator("div.ProseMirror").first
        await box.click()
        await page.keyboard.type(args.prompt, delay=12)
        await page.wait_for_timeout(300)
        await page.keyboard.press("Enter")
        write_job(args.job, status="running", message="已提交，等待豆包生成…")

        deadline = time.time() + args.timeout
        verify_noted = False
        confirm_clicked = False
        video_attempts = 0
        while time.time() < deadline:
            data = await collect_media(page)
            text = data["text"]
            if CAPTCHA_HINT in text:
                if not verify_noted:
                    verify_noted = True
                    write_job(args.job, status="verify", message="豆包要求人机验证，请在豆包窗口里完成，完成后会自动继续。")
                    await page.bring_to_front()
                await asyncio.sleep(4)
                continue
            # 视频会先给一份参数确认单，需要回复「确认」才真正开始
            if not confirm_clicked and ("确认后我再开始生成" in text or "参数确认" in text):
                await box.click()
                await page.keyboard.type("确认")
                await page.wait_for_timeout(200)
                await page.keyboard.press("Enter")
                confirm_clicked = True
                write_job(args.job, status="running", message="已确认参数，豆包开始生成…")
                await asyncio.sleep(3)
                continue
            for hint in ERROR_HINTS:
                if hint in text:
                    write_job(args.job, status="failed", message=f"豆包返回：{text[-160:].strip()}")
                    return
            if args.kind == "video" and video_attempts < 3 and ("视频生成好了" in text or "视频已生成" in text):
                video_attempts += 1
                source = await open_video_card(page, context) or await find_video_src(context)
                if source:
                    target = MEDIA / f"{args.job}.mp4"
                    await save_media(context, source, target)
                    write_job(args.job, status="done", message="生成完成", file=target.name, source=source[:300])
                    return
                write_job(args.job, status="running", message="视频已生成，正在打开取回…")
                await asyncio.sleep(3)
                continue
            media = data["images"] if args.kind == "image" else data["videos"]
            fresh = [url for url in media if url not in before_set]
            if fresh:
                url = fresh[-1]
                ext = guess_ext(url, "png" if args.kind == "image" else "mp4")
                target = MEDIA / f"{args.job}.{ext}"
                await save_media(context, url, target)
                actual = sniff_ext(target)
                if actual and actual != ext:
                    fixed = MEDIA / f"{args.job}.{actual}"
                    target.replace(fixed)
                    target = fixed
                write_job(args.job, status="done", message="生成完成", file=target.name, source=url[:300])
                return
            await asyncio.sleep(4)
        write_job(args.job, status="failed", message="等待生成超时，请稍后在豆包窗口里查看。")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--kind", choices=["image", "video"], required=True)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--timeout", type=int, default=420)
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except Exception as error:  # noqa: BLE001
        write_job(args.job, status="failed", message=f"生成失败：{error}")
        raise


if __name__ == "__main__":
    main()
