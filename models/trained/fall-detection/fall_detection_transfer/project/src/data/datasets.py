"""Public fall-detection datasets you can train on, and the expected on-disk
layout for this pipeline.

EXPECTED LAYOUT (what prepare_dataset.py reads):

    data_raw/
      fall/   *.mp4 *.avi     # clips that CONTAIN a fall
      adl/    *.mp4 *.avi     # normal activity, NO fall
    annotations.csv           # optional, columns: video,fall_start_sec,fall_end_sec
                              # (video = filename; only for clips in fall/)

If a fall clip has no annotation row, the whole clip's windows are labeled fall
(noisier — a warning is printed). Annotations sharpen the labels a lot.

RECOMMENDED FREE DATASETS
-------------------------
URFD  — UR Fall Detection (Kwolek & Kepski, 2014). 30 falls + 40 ADL, RGB+depth.
        http://fenix.ur.edu.pl/~mkepski/ds/uf.html
Le2i  — Fall detection dataset, multiple rooms/lighting (good for CCTV realism).
        https://search-data.ubfc.fr/  (search "Le2i fall detection")
UP-Fall— Multimodal, 17 subjects, several cameras.
        https://sites.google.com/up.edu.mx/har-up/
GMDCSA— From Alam et al. (2024), the paper this project builds on.
        https://github.com/ekramalam/RTHFD  (dataset link in the repo/paper)

For CCTV realism prefer Le2i / UP-Fall (varied camera angles, multiple people).
Mix several datasets so the model generalizes across rooms and viewpoints.
"""

VIDEO_EXTS = (".mp4", ".avi", ".mov", ".mkv")
