from __future__ import annotations

import logging

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .pipeline import (
    DEFAULT_CODEFORMER_WEIGHT,
    FaceReconstructionPipeline,
    decode_upload_image,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logging.getLogger().setLevel(logging.INFO)


app = FastAPI(title="Forensic Face Reconstruction API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

pipeline: FaceReconstructionPipeline | None = None


def get_pipeline() -> FaceReconstructionPipeline:
    global pipeline
    if pipeline is None:
        pipeline = FaceReconstructionPipeline()
    return pipeline


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/reconstruct")
async def reconstruct_face(
    file: UploadFile = File(...),
    fidelity_weight: float = Form(DEFAULT_CODEFORMER_WEIGHT),
) -> dict:
    if file.content_type is None or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Upload must be an image file")

    if not 0.0 <= fidelity_weight <= 1.0:
        raise HTTPException(status_code=400, detail="fidelity_weight must be between 0 and 1")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")

    try:
        image = decode_upload_image(raw)
        return get_pipeline().run(image, fidelity_weight=fidelity_weight)
    except ValueError as err:
        raise HTTPException(status_code=400, detail=str(err)) from err
    except FileNotFoundError as err:
        raise HTTPException(status_code=500, detail=str(err)) from err
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"Reconstruction failed: {err}") from err
