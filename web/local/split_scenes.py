import base64, json, os, subprocess, sys
sys.path.insert(0, os.path.join(os.environ.get("CANVAS_DATA_ROOT", "D:/CodexData/.codex/infinite-canvas"), "python"))
from scenedetect import detect, AdaptiveDetector, open_video

source, output, work = sys.argv[1:4]
ffmpeg = os.environ.get("CANVAS_FFMPEG", "ffmpeg")
if len(sys.argv) > 4 and sys.argv[4] == 'segments':
    video = open_video(source)
    duration = video.duration.get_seconds()
    scenes = []
    start = 0.0
    while start < duration:
        end = min(start + 10, duration)
        scenes.append((start, end))
        start = end
else:
    scenes = [(start.get_seconds(), end.get_seconds()) for start, end in detect(source, AdaptiveDetector())]
if not scenes:
    video = open_video(source)
    scenes = [(0.0, video.duration.get_seconds())]
result = []
for index, (start, end) in enumerate(scenes):
    begin, finish = start, end
    clip = os.path.join(work, f'scene-{index:05d}.mp4')
    frame = os.path.join(work, f'scene-{index:05d}.jpg')
    subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-ss', str(begin), '-i', source, '-t', str(finish - begin), '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', clip], check=True)
    subprocess.run([ffmpeg, '-y', '-loglevel', 'error', '-i', clip, '-frames:v', '1', frame], check=True)
    if 'files' in sys.argv[5:]:
        result.append({'start': begin, 'end': finish})
    else:
        with open(clip, 'rb') as f: video_data = base64.b64encode(f.read()).decode('ascii')
        with open(frame, 'rb') as f: image_data = base64.b64encode(f.read()).decode('ascii')
        result.append({'start': begin, 'end': finish, 'video': video_data, 'image': image_data})
with open(output, 'w', encoding='utf-8') as f: json.dump({'scenes': result}, f, ensure_ascii=False)
