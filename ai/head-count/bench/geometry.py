"""Turn the measured pixel limits into a mounting spec.

The detector's only real currency is HEAD PIXELS AT MODEL INPUT. Measured:
    >=12 px -> 97.8% recall   |   >=16 px -> 99.2%   |   <8 px -> 20%

For a frame letterboxed to `imgsz` on the long side:

    px_model = (V/W) * imgsz * h_head / (2 * d * tan(vfov/2))

Note what is ABSENT: the camera's native pixel count. Once we resize to imgsz,
sensor resolution cancels out. Range is set by FOV and imgsz, not megapixels.
"""
import json
import math

H_HEAD = 0.24          # metres, crown to chin incl. hair
HEAD_PLANE = 1.60      # metres, average standing head height
ASPECT = 9 / 16        # V/W
SENSOR_H_MM = 3.2      # 1/2.8" 16:9 sensor, vertical
LENSES = [2.8, 4.0, 6.0, 8.0, 12.0]
IMGSZ = [640, 960, 1280]
TARGETS = {"good (97.8%)": 12, "high-confidence (99.2%)": 16}


def vfov_deg(f_mm):
    return math.degrees(2 * math.atan(SENSOR_H_MM / (2 * f_mm)))


def hfov_deg(f_mm):
    return math.degrees(2 * math.atan((SENSOR_H_MM / ASPECT) / (2 * f_mm)))


def max_slant(f_mm, imgsz, px_target):
    """Furthest a head can be and still clear px_target at the model input."""
    t = math.tan(math.radians(vfov_deg(f_mm)) / 2)
    return ASPECT * imgsz * H_HEAD / (2 * px_target * t)


def reach(d, mount_h):
    """Slant range -> horizontal floor distance, and the tilt to aim there."""
    dh = mount_h - HEAD_PLANE
    if d <= dh:
        return 0.0, 90.0
    x = math.sqrt(d * d - dh * dh)
    return x, math.degrees(math.atan2(dh, x))


print("=" * 78)
print("PIXELS PER METRE required at the head plane (measured at model input)")
print("=" * 78)
for label, px in TARGETS.items():
    print(f"  {label:<26} {px} px on a {H_HEAD} m head  ->  "
          f"{px / H_HEAD:.0f} px/m at model input")
print()
print("  Native camera px/m needed = model px/m x (native_width / imgsz)")
for w, name in [(1920, "1080p"), (2560, "1440p"), (3840, "4K")]:
    f = w / 640
    print(f"    {name:<6} @ imgsz 640: x{f:.0f}  ->  "
          f"{12 / H_HEAD * f:.0f} px/m native for the 'good' tier")

print()
print("=" * 78)
print("MAX RANGE (metres, slant) — 1/2.8\" sensor")
print("=" * 78)
hdr = f"{'lens':>6} {'HFOV':>6} {'VFOV':>6} |" + "".join(
    f"{'imgsz ' + str(s):>13}" for s in IMGSZ)
print(hdr)
print(f"{'':>6} {'':>6} {'':>6} |" + "".join(f"{'12px / 16px':>13}" for _ in IMGSZ))
print("-" * len(hdr))
table = []
for f in LENSES:
    row = f"{f:>5.1f}mm {hfov_deg(f):>5.0f}° {vfov_deg(f):>5.0f}° |"
    entry = {"lens_mm": f, "hfov": round(hfov_deg(f)), "vfov": round(vfov_deg(f))}
    for s in IMGSZ:
        d12, d16 = max_slant(f, s, 12), max_slant(f, s, 16)
        row += f"{d12:>6.1f} /{d16:>5.1f}"
        entry[f"imgsz{s}"] = {"d12": round(d12, 1), "d16": round(d16, 1)}
    print(row)
    table.append(entry)

print()
print("=" * 78)
print("MOUNTING HEIGHT -> horizontal reach & tilt   (imgsz 640, 12 px target)")
print("=" * 78)
print(f"{'lens':>7} {'mount':>7} {'slant':>7} {'floor reach':>12} {'tilt down':>10}")
print("-" * 48)
mounts = []
for f in [2.8, 4.0, 6.0]:
    d = max_slant(f, 640, 12)
    for h in [2.5, 3.0, 4.0, 5.0]:
        x, tilt = reach(d, h)
        print(f"{f:>6.1f}mm {h:>6.1f}m {d:>6.1f}m {x:>11.1f}m {tilt:>9.1f}°")
        mounts.append({"lens_mm": f, "mount_m": h, "slant_m": round(d, 1),
                       "floor_reach_m": round(x, 1), "tilt_deg": round(tilt, 1)})
    print()

print("=" * 78)
print("SHUTTER CEILING from the measured motion-blur curve")
print("=" * 78)
print("  blur budget is in px AT MODEL INPUT; a 12 px head = 50 px/m")
for px_head, tier in [(12, "minimum"), (16, "high-confidence")]:
    ppm = px_head / H_HEAD
    for blur_px, recall in [(3, "99.4%"), (5, "97.5%"), (7, "92.0%"), (9, "68.5%")]:
        travel = blur_px / ppm                       # metres of head travel
        for speed, gait in [(1.4, "walking")]:
            t = travel / speed
            print(f"  {tier:<16} blur {blur_px:>2} px ({recall:>5}) = "
                  f"{travel * 100:>4.0f} cm of {gait} = shutter 1/{1 / t:>3.0f} s")
    print()

with open("/out/geometry.json", "w") as fh:
    json.dump({"range_table": table, "mounting": mounts}, fh, indent=1)
