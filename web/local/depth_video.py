import sys, subprocess
import cv2
import numpy as np
import onnxruntime as ort

source, output, model, ffmpeg = sys.argv[1:]
session = ort.InferenceSession(model, providers=['CPUExecutionProvider'])
video = cv2.VideoCapture(source)
if not video.isOpened(): raise RuntimeError('无法读取视频')
fps = video.get(cv2.CAP_PROP_FPS)
width, height = int(video.get(cv2.CAP_PROP_FRAME_WIDTH)), int(video.get(cv2.CAP_PROP_FRAME_HEIGHT))
if not fps or not width or not height: raise RuntimeError('视频尺寸或帧率无效')
encoder = subprocess.Popen([ffmpeg, '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', f'{width}x{height}', '-r', str(fps), '-i', '-', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], stdin=subprocess.PIPE)
mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
try:
    while True:
        ok, frame = video.read()
        if not ok: break
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = cv2.resize(rgb, (518, 518), interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255.0
        image = ((image - mean) / std).transpose(2, 0, 1)[None].astype(np.float32)
        depth = np.squeeze(session.run(None, {session.get_inputs()[0].name: image})[0])
        depth = cv2.resize(depth, (width, height), interpolation=cv2.INTER_CUBIC)
        low, high = np.percentile(depth, (2, 98))
        gray = np.clip((depth - low) * (255.0 / max(float(high-low), 1e-6)), 0, 255).astype(np.uint8)
        encoder.stdin.write(gray.tobytes())
finally:
    video.release()
    encoder.stdin.close()
if encoder.wait() != 0: raise RuntimeError('视频编码失败')
