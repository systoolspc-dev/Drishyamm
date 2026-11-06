from __future__ import annotations

import base64
import logging
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple, Optional
from unittest.mock import MagicMock

import cv2
import numpy as np
import torch
from torchvision.transforms.functional import normalize

# 1. First, tell Python where the CodeFormer folder is
ROOT_DIR = Path(__file__).resolve().parents[2]
CODEFORMER_DIR = ROOT_DIR / "CodeFormer"
if str(CODEFORMER_DIR) not in sys.path:
    sys.path.insert(0, str(CODEFORMER_DIR))

# --- THE FIX: Bypass the missing 'data' folder in CodeFormer's basicsr.
#
# CodeFormer ships a stripped-down basicsr fork with no `data/` package.
# When `basicsr/__init__.py` runs `from .train import *`, train.py reaches
# for several `basicsr.data.*` submodules that don't exist on disk. We
# pre-populate sys.modules with mocks before any basicsr import fires.
#
# When adding submodules: trace the next ModuleNotFoundError, look at
# which CodeFormer/basicsr file the import comes from, append it here.
# We've hit, in order: degradations, data_util, transforms, data_sampler,
# prefetch_dataloader. If new ones appear in a future CodeFormer update,
# extend the list — pipeline imports are the only safety check.
mock_data_pkg = MagicMock()
mock_data_pkg.__path__ = []

sys.modules['basicsr.data'] = mock_data_pkg
sys.modules['basicsr.data.degradations'] = MagicMock()
sys.modules['basicsr.data.data_util'] = MagicMock()
sys.modules['basicsr.data.transforms'] = MagicMock()
sys.modules['basicsr.data.data_sampler'] = MagicMock()
# Required by basicsr/train.py's `from basicsr.data.prefetch_dataloader
# import CPUPrefetcher, CUDAPrefetcher`. Without this, the FastAPI
# process can't even import pipeline.py and crashloops at startup.
sys.modules['basicsr.data.prefetch_dataloader'] = MagicMock()

from basicsr.utils import img2tensor, tensor2img  # noqa: E402 #type:ignore
from basicsr.utils.registry import ARCH_REGISTRY  # noqa: E402 #type:ignore
from facelib.utils.face_restoration_helper import FaceRestoreHelper  # noqa: E402 #type:ignore

# 2. RealESRGAN safe imports & Mocking fixes
try:
    from basicsr.archs.rrdbnet_arch import RRDBNet  # noqa: E402 #type:ignore
    
    # Mock broken basicsr utilities so RealESRGAN inference doesn't crash on boot
    import basicsr.utils
    basicsr.utils.DiffJPEG = MagicMock
    basicsr.utils.USMSharp = MagicMock
    basicsr.utils.filter2D = MagicMock
    sys.modules['basicsr.utils.img_process_util'] = MagicMock()
    
    from realesrgan import RealESRGANer  # noqa: E402 #type:ignore
    REALESRGAN_IMPORT_ERROR = None
except Exception as err:  # pragma: no cover
    RRDBNet = None  # type: ignore[assignment]
    RealESRGANer = None  # type: ignore[assignment]
    REALESRGAN_IMPORT_ERROR = err

DEFAULT_CODEFORMER_WEIGHT = 0.5
logger = logging.getLogger(__name__)

@dataclass
class DegradationReport:
    blur_variance: float
    blur_level: str
    noise_sigma: float
    noise_level: str
    compression_blockiness: float
    compression_level: str
    overall_level: str

    def as_dict(self) -> Dict[str, object]:
        return {
            "blur_variance": round(self.blur_variance, 3),
            "blur_level": self.blur_level,
            "noise_sigma": round(self.noise_sigma, 3),
            "noise_level": self.noise_level,
            "compression_blockiness": round(self.compression_blockiness, 5),
            "compression_level": self.compression_level,
            "overall_level": self.overall_level,
        }

class CodeFormerRestorer:
    def __init__(self, model_path: Path, bg_model_path: Path) -> None:
        if not model_path.exists():
            raise FileNotFoundError(f"CodeFormer model weights not found: {model_path}")

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        
        # Initialize CodeFormer
        self.net = ARCH_REGISTRY.get("CodeFormer")(
            dim_embd=512,
            codebook_size=1024,
            n_head=8,
            n_layers=9,
            connect_list=["32", "64", "128", "256"],
        ).to(self.device)

        checkpoint = torch.load(model_path, map_location=self.device)
        self.net.load_state_dict(checkpoint.get("params_ema", checkpoint), strict=True)
        self.net.eval()

        # Initialize RealESRGAN
        self.bg_upsampler = None
        if RRDBNet is None or RealESRGANer is None:
            logger.warning(f"RealESRGAN import failed ({REALESRGAN_IMPORT_ERROR}). Background upsampling disabled.")
        elif bg_model_path.exists():
            half = True if torch.cuda.is_available() else False
            model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32, scale=2)
            self.bg_upsampler = RealESRGANer(
                scale=2, model_path=str(bg_model_path), model=model, tile=400, tile_pad=10, pre_pad=0, half=half, device=self.device
            )
            logger.info("RealESRGAN background upsampler loaded successfully.")
        else:
            logger.warning(f"RealESRGAN weights not found at {bg_model_path}. Background upsampling disabled.")

        # Initialize FaceRestoreHelper
        self.face_helper = FaceRestoreHelper(
            upscale_factor=2 if self.bg_upsampler else 1, face_size=512, crop_ratio=(1, 1),
            det_model='retinaface_resnet50', save_ext='png', use_parse=True, device=self.device
        )

    def is_cropped_face(self, image_bgr: np.ndarray, threshold_ratio: float = 0.35) -> bool:
        """Determines if the image is primarily a face to trigger the smart router."""
        try:
            self.face_helper.clean_all()
            self.face_helper.read_image(image_bgr)
            self.face_helper.get_face_landmarks_5(only_center_face=True, resize=640, eye_dist_threshold=5)
            
            if len(self.face_helper.det_faces) == 0:
                return False 
                
            bbox = self.face_helper.det_faces[0]
            
            if np.isscalar(bbox) or len(bbox) < 4:
                logger.warning("Smart Router -> Malformed bounding box detected. Defaulting to scene mode.")
                return False

            face_area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
            img_area = image_bgr.shape[0] * image_bgr.shape[1]
            
            if img_area == 0:
                return False

            ratio = face_area / img_area
            logger.info(f"Smart Router -> Face Coverage Ratio: {ratio:.2f}")
            return ratio > threshold_ratio
            
        except Exception as e:
            logger.warning(f"Smart Router failed ({str(e)}). Defaulting to scene mode.")
            return False

    def restore_pure_sr(self, face_bgr: np.ndarray) -> np.ndarray:
        """Fallback: Uses only Real-ESRGAN to upscale heavily degraded images, avoiding GAN hallucinations."""
        if self.bg_upsampler is not None:
            sr_img, _ = self.bg_upsampler.enhance(face_bgr, outscale=2)
            return sr_img.astype(np.uint8)
        else:
            logger.warning("RealESRGAN not available for Pure SR fallback. Returning original.")
            return face_bgr

    def restore_aligned(self, face_bgr: np.ndarray, fidelity_weight: float) -> np.ndarray:
        """Direct CodeFormer inference for cropped faces. Bypasses rotation and background scaling."""
        fidelity_weight = float(np.clip(fidelity_weight, 0.0, 1.0))
        cf_input = cv2.resize(face_bgr, (512, 512), interpolation=cv2.INTER_LINEAR)
        
        face_t = img2tensor(cf_input / 255.0, bgr2rgb=True, float32=True)
        normalize(face_t, (0.5, 0.5, 0.5), (0.5, 0.5, 0.5), inplace=True)
        face_t = face_t.unsqueeze(0).to(self.device)

        with torch.no_grad():
            output = self.net(face_t, w=fidelity_weight, adain=True)[0]
            restored_face = tensor2img(output, rgb2bgr=True, min_max=(-1, 1))

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            
        h, w = face_bgr.shape[:2]
        return cv2.resize(restored_face, (w, h)).astype(np.uint8)

    def restore(self, face_bgr: np.ndarray, fidelity_weight: float) -> np.ndarray:
        """Full scene mode: 2x background upscaling + CodeFormer face stitching."""
        fidelity_weight = float(np.clip(fidelity_weight, 0.0, 1.0))

        bg_img = None
        if self.bg_upsampler is not None:
            bg_img, _ = self.bg_upsampler.enhance(face_bgr, outscale=2)

        self.face_helper.clean_all()
        self.face_helper.read_image(face_bgr)
        self.face_helper.get_face_landmarks_5(only_center_face=False, resize=640, eye_dist_threshold=5)
        self.face_helper.align_warp_face()
        
        if len(self.face_helper.cropped_faces) == 0:
            logger.warning("No face detected! Returning Real-ESRGAN background only.")
            return bg_img if bg_img is not None else face_bgr

        for aligned_face in self.face_helper.cropped_faces:
            face_t = img2tensor(aligned_face / 255.0, bgr2rgb=True, float32=True)
            normalize(face_t, (0.5, 0.5, 0.5), (0.5, 0.5, 0.5), inplace=True)
            face_t = face_t.unsqueeze(0).to(self.device)

            with torch.no_grad():
                output = self.net(face_t, w=fidelity_weight, adain=True)[0]
                restored_face = tensor2img(output, rgb2bgr=True, min_max=(-1, 1))

            self.face_helper.add_restored_face(restored_face)

        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        self.face_helper.get_inverse_affine(None)
        restored_img = self.face_helper.paste_faces_to_input_image(upsample_img=bg_img, draw_box=False)

        return restored_img.astype(np.uint8)

class FaceReconstructionPipeline:
    def __init__(self) -> None:
        model_path = CODEFORMER_DIR / "weights" / "CodeFormer" / "codeformer.pth"
        bg_model_path = CODEFORMER_DIR / "weights" / "realesrgan" / "RealESRGAN_x2plus.pth"
        
        self.codeformer = CodeFormerRestorer(model_path=model_path, bg_model_path=bg_model_path)

    def run(self, image_bgr: np.ndarray, fidelity_weight: float = DEFAULT_CODEFORMER_WEIGHT) -> Dict[str, object]:
        fidelity_weight = float(np.clip(fidelity_weight, 0.0, 1.0))
        logger.info("running the model with weight: %.3f", fidelity_weight)
        
        report = self._triage(image_bgr)
        stages = self._forensic_enhancement(image_bgr, iterations=3)
        stage3 = stages[-1]

        try:
            # --- THE SMART ROUTER IN ACTION ---
            is_extreme_degradation = (report.blur_level == "severe" and report.compression_level in ["moderate", "severe"])
            
            if is_extreme_degradation:
                logger.info("Routing to PURE SR MODE (Extreme degradation detected - preventing hallucination)")
                reconstructed = self.codeformer.restore_pure_sr(image_bgr)
            elif self.codeformer.is_cropped_face(image_bgr):
                logger.info("Routing to ALIGNED MODE (Cropped Face Detected)")
                reconstructed = self.codeformer.restore_aligned(image_bgr, fidelity_weight=fidelity_weight)
            else:
                logger.info("Routing to REAL-ESRGAN MODE (Full Scene Detected)")
                reconstructed = self.codeformer.restore(image_bgr, fidelity_weight=fidelity_weight)
                
            reconstruction_error = None
        except Exception as err:  # pragma: no cover
            logger.error(f"Reconstruction failed: {str(err)}")
            reconstructed = stage3
            reconstruction_error = str(err)

        response: Dict[str, object] = {
            "triage": report.as_dict(),
            "original_image": self._to_base64_png(image_bgr),
            "enhancement_stages": [
                {"stage": i + 1, "image": self._to_base64_png(stage_img)} for i, stage_img in enumerate(stages)
            ],
            "final_enhanced_image": self._to_base64_png(stage3),
            "reconstruction_image": self._to_base64_png(reconstructed),
            "fidelity_weight": round(fidelity_weight, 3),
            "device": str(self.codeformer.device),
        }
        if reconstruction_error:
            response["reconstruction_error"] = reconstruction_error
        return response

    def _triage(self, image_bgr: np.ndarray) -> DegradationReport:
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        blur_variance = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        noise_sigma = self._estimate_noise(gray)
        compression_blockiness = self._estimate_blockiness(gray)

        blur_level = self._classify_blur(blur_variance)
        noise_level = self._classify_noise(noise_sigma)
        compression_level = self._classify_compression(compression_blockiness)
        overall = self._combine_levels([blur_level, noise_level, compression_level])

        return DegradationReport(
            blur_variance=blur_variance, blur_level=blur_level, noise_sigma=noise_sigma, noise_level=noise_level,
            compression_blockiness=compression_blockiness, compression_level=compression_level, overall_level=overall,
        )

    def _forensic_enhancement(self, image_bgr: np.ndarray, iterations: int) -> List[np.ndarray]:
        stages: List[np.ndarray] = []
        enhanced = image_bgr.copy()
        gentle_clahe = cv2.createCLAHE(clipLimit=1.2, tileGridSize=(8, 8))

        for i in range(iterations):
            d = max(3, 7 - (i * 2)) 
            enhanced = cv2.bilateralFilter(enhanced, d=d, sigmaColor=25, sigmaSpace=25)

            lab = cv2.cvtColor(enhanced, cv2.COLOR_BGR2LAB)
            l_channel, a_channel, b_channel = cv2.split(lab)
            l_channel = gentle_clahe.apply(l_channel)
            enhanced = cv2.cvtColor(cv2.merge((l_channel, a_channel, b_channel)), cv2.COLOR_LAB2BGR)

            enhanced_float = enhanced.astype(np.float32)
            lap = cv2.Laplacian(enhanced_float, cv2.CV_32F, ksize=3)
            lap_weight = 0.15 / (i + 1) 
            sharpened = np.clip(enhanced_float - lap_weight * lap, 0, 255)
            enhanced = sharpened.astype(np.uint8)
            stages.append(enhanced.copy())
            
        return stages

    @staticmethod
    def _to_base64_png(image_bgr: np.ndarray) -> str:
        ok, buf = cv2.imencode(".png", image_bgr)
        if not ok: raise ValueError("Failed to encode image as PNG")
        return base64.b64encode(buf.tobytes()).decode("ascii")

    @staticmethod
    def _estimate_noise(gray: np.ndarray) -> float:
        img = gray.astype(np.float32)
        h, w = img.shape
        if h < 3 or w < 3: return 0.0
        kernel = np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]], dtype=np.float32)
        response = cv2.filter2D(img, -1, kernel)
        sigma = np.sum(np.abs(response)) * np.sqrt(0.5 * np.pi)
        sigma /= 6.0 * (w - 2) * (h - 2)
        return float(sigma)

    @staticmethod
    def _estimate_blockiness(gray: np.ndarray) -> float:
        img = gray.astype(np.float32)
        h, w = img.shape
        if h < 16 or w < 16: return 0.0
        v_bounds = np.arange(8, w, 8)
        h_bounds = np.arange(8, h, 8)
        v_diff = np.abs(img[:, v_bounds] - img[:, v_bounds - 1])
        h_diff = np.abs(img[h_bounds, :] - img[h_bounds - 1, :])
        int_v_idx = np.array([i for i in range(1, w) if i % 8 != 0], dtype=np.int32)
        int_h_idx = np.array([i for i in range(1, h) if i % 8 != 0], dtype=np.int32)
        if int_v_idx.size == 0 or int_h_idx.size == 0: return 0.0
        iv_diff = np.abs(img[:, int_v_idx] - img[:, int_v_idx - 1])
        ih_diff = np.abs(img[int_h_idx, :] - img[int_h_idx - 1, :])
        b_mean = (float(np.mean(v_diff)) + float(np.mean(h_diff))) / 2.0
        i_mean = (float(np.mean(iv_diff)) + float(np.mean(ih_diff))) / 2.0 + 1e-6
        return max((b_mean - i_mean) / 255.0, 0.0)

    @staticmethod
    def _classify_blur(variance: float) -> str:
        if variance < 60: return "severe"
        if variance < 160: return "moderate"
        return "mild"

    @staticmethod
    def _classify_noise(sigma: float) -> str:
        if sigma > 22: return "severe"
        if sigma > 10: return "moderate"
        return "mild"

    @staticmethod
    def _classify_compression(blockiness: float) -> str:
        if blockiness > 0.09: return "severe"
        if blockiness > 0.04: return "moderate"
        return "mild"

    @staticmethod
    def _combine_levels(levels: List[str]) -> str:
        score = sum({"mild": 1, "moderate": 2, "severe": 3}[lvl] for lvl in levels)
        if score >= 8: return "severe"
        if score >= 5: return "moderate"
        return "mild"

def decode_upload_image(raw_bytes: bytes) -> np.ndarray:
    arr = np.frombuffer(raw_bytes, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None: raise ValueError("Invalid image input")
    return image