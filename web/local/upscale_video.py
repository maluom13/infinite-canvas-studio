import json, math, os, subprocess, sys

source, output, work, level = sys.argv[1:5]
mode = sys.argv[5] if len(sys.argv) > 5 else 'natural'
ffmpeg = os.environ.get("CANVAS_FFMPEG", "ffmpeg")
ffprobe = os.environ.get("CANVAS_FFPROBE", "ffprobe")
root = os.path.join(os.environ.get("CANVAS_DATA_ROOT", "D:/CodexData/.codex/infinite-canvas"), "upscale", "full")
exe = os.path.join(root, 'realesrgan-ncnn-vulkan.exe')
info = json.loads(subprocess.check_output([ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate', '-of', 'json', source]))['streams'][0]
w, h = int(info['width']), int(info['height'])
target = {'1k': 1024, '2k': 2048, '4k': 3840}[level]
if max(w, h) >= target: raise RuntimeError('原视频已达到目标尺寸，请选择更高分辨率')
ratio = target / max(w, h)
tw, th = max(2, round(w * ratio / 2) * 2), max(2, round(h * ratio / 2) * 2)
if mode == 'natural':
    subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-i', source, '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0', '-vf', f'scale={tw}:{th}:flags=bicubic', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output], check=True)
else:
    frames, enlarged = os.path.join(work, 'frames'), os.path.join(work, 'upscaled')
    os.makedirs(frames); os.makedirs(enlarged)
    subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-i', source, '-map', '0:v:0', '-vsync', '0', os.path.join(frames, '%08d.png')], check=True)
    subprocess.run([exe, '-i', frames, '-o', enlarged, '-n', 'realesrgan-x4plus', '-m', os.path.join(root, 'models'), '-s', '4', '-f', 'png'], cwd=root, check=True)
    subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-framerate', info['avg_frame_rate'], '-i', os.path.join(enlarged, '%08d.png'), '-i', source, '-map', '0:v:0', '-map', '1:a?', '-vf', f'scale={tw}:{th}:flags=lanczos', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', output], check=True)
result = json.loads(subprocess.check_output([ffprobe, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', output]))['streams'][0]
if (int(result['width']), int(result['height'])) != (tw, th):
    raise RuntimeError('输出分辨率与目标不一致')
