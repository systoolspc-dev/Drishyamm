import time, cv2, numpy as np
from ultralytics import YOLO
m = YOLO("/srv/head-count/models/abel/best.pt")
cap = cv2.VideoCapture("/demo/crowd.mp4"); ok, fr = cap.read(); cap.release()
print("imgsz | p50 ms | fps/stream | streams @ 4fps target")
for sz in [640, 800, 960, 1280]:
    for _ in range(5): m.predict(fr, imgsz=sz, conf=0.4, verbose=False)
    ts=[]
    for _ in range(30):
        t=time.perf_counter(); m.predict(fr, imgsz=sz, conf=0.4, verbose=False)
        ts.append((time.perf_counter()-t)*1000)
    p50=float(np.median(ts))
    print("%5d | %6.1f | %10.1f | %d" % (sz, p50, 1000/p50, int((1000/p50)/4)))
