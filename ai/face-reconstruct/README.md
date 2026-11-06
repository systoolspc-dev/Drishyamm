# Forensic Face Reconstruction

A high-performance web application for forensic-grade face restoration and reconstruction. This project leverages the **CodeFormer GAN** and **Real-ESRGAN** to breathe life into old, blurry, or heavily degraded facial images.

## 🚀 Overview

This application provides an end-to-end pipeline for facial image enhancement. It doesn't just upscale; it intelligently analyzes the input image to apply the most appropriate restoration strategy, ensuring high fidelity and minimizing "hallucinations" common in AI restoration.

### Key Features

*   **Smart Routing:** Automatically detects if the input is a cropped face or a full scene and selects the optimal processing mode (**Aligned Mode** vs **Full Scene Mode**).
*   **Extreme Degradation Handling:** Includes a **Pure SR Mode** to prevent AI artifacts on heavily damaged images.
*   **Forensic Triage:** Analyzes image quality (blur, noise, compression) before processing to provide a "Triage Report."
*   **Multi-Stage Enhancement:** Applies iterative forensic filters (Bilateral filtering, CLAHE, and Laplacian sharpening) to prepare images for the GAN.
*   **Adjustable Fidelity:** Users can control the balance between face restoration and identity preservation using a fidelity weight slider.
*   **Background Upscaling:** Integrated with **Real-ESRGAN** for high-quality background restoration in full-scene images.

## 🛠️ Tech Stack

### Backend
*   **Framework:** [FastAPI](https://fastapi.tiangolo.com/) (Running on Port 8001)
*   **AI Models:** 
    *   **CodeFormer:** For high-quality face restoration.
    *   **Real-ESRGAN:** For background upsampling.
*   **Libraries:** PyTorch, OpenCV, NumPy, Torchvision.
*   **Inference:** Custom pipeline with smart routing and triage.

### Frontend
*   **Framework:** [React](https://reactjs.org/) (Version 18+)
*   **Build Tool:** [Vite](https://vitejs.dev/)
*   **Styling:** Vanilla CSS for a clean, responsive UI.

---

## ⚙️ Installation & Setup

### Prerequisites
*   Python 3.10+
*   Node.js (v18+)
*   NPM or Yarn
*   CUDA-enabled GPU (Optional, but recommended for faster processing)


### 1. Backend Setup
```bash
cd backend
# Create a virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run the backend server
uvicorn app.main:app --host 0.0.0.0 --port 8001
```
*The backend will be available at `http://localhost:8001`.*

### 2. Frontend Setup
```bash
cd ../frontend
# Install dependencies
npm install

# Run the development server
npm run dev
```
*The frontend will be available at `http://localhost:5173`.*

---

## 📂 Project Structure

```text
FaceReconstruction/
├── backend/                # FastAPI Backend
│   ├── app/                # Application logic (main.py, pipeline.py)
│   └── requirements.txt    # Python dependencies
├── frontend/               # React + Vite Frontend
│   ├── src/                # UI components and styles
│   └── package.json        # Frontend dependencies
├── CodeFormer/             # CodeFormer Model Core (Submodule/Cloned)
│   ├── weights/            # Model weights (CodeFormer & Real-ESRGAN)
│   └── inference_*.py      # Core inference scripts
└── README.md               # You are here!
```

---

## 🛠️ Usage

1.  Start the Backend and Frontend servers.
2.  Open your browser to the Frontend URL.
3.  Upload an image (supports PNG, JPG, JPEG).
4.  Adjust the **Fidelity Weight** (0.0 = maximum restoration, 1.0 = maximum identity preservation).
5.  Click **Reconstruct** and view the multi-stage results!

---

## 📜 Acknowledgements

*   **CodeFormer:** [S. Zhou et al. "Towards Robust Blind Face Restoration with Codebook Lookup Transformer"](https://github.com/sczhou/CodeFormer)
*   **Real-ESRGAN:** [X. Wang et al. "Real-ESRGAN: Training Real-World Blind Super-Resolution with Pure Synthetic Data"](https://github.com/xinntao/Real-ESRGAN)
*   **FastAPI:** For the lightning-fast API layer.

---
*Created with ❤️ for the AI & Forensic Community.*
