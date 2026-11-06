import os
import sys
import argparse
import yaml
from pathlib import Path

def setup_portable_yaml(yaml_path):
    """
    Updates the data.yaml to use a portable relative path.
    Ultralytics resolves paths relative to the 'path' key if specified.
    """
    yaml_path = Path(yaml_path)
    if not yaml_path.exists():
        print(f"[!] data.yaml not found at {yaml_path}")
        return False
        
    with open(yaml_path, 'r') as f:
        data = yaml.safe_load(f)
    
    # Update to portable layout
    # This assumes data.yaml is at the root of the dataset folder containing train/valid/test
    data['path'] = str(yaml_path.parent.absolute())
    data['train'] = 'train/images'
    data['val'] = 'valid/images'
    if 'test' in data:
        data['test'] = 'test/images'
        
    # Write back the portable version
    portable_yaml_path = yaml_path.parent / "data_portable.yaml"
    with open(portable_yaml_path, 'w') as f:
        yaml.safe_dump(data, f, default_flow_style=False)
        
    print(f"[✓] Created portable dataset config at: {portable_yaml_path}")
    print("    - Path root set to:", data['path'])
    return portable_yaml_path

def main():
    parser = argparse.ArgumentParser(description="Train YOLO26 on Crowd Counting Dataset")
    parser.add_argument("--model", type=str, default="yolo26m.pt", 
                        choices=["yolo26n.pt", "yolo26s.pt", "yolo26m.pt", "yolo26l.pt", "yolo26x.pt"],
                        help="YOLO26 model variant to train (default: yolo26m.pt)")
    parser.add_argument("--epochs", type=int, default=100, help="Number of training epochs")
    parser.add_argument("--batch", type=int, default=16, help="Batch size (-1 for auto)")
    parser.add_argument("--imgsz", type=int, default=640, help="Input image size")
    parser.add_argument("--device", type=str, default="", help="Device to use (e.g. 0, 1, cpu, mps)")
    parser.add_argument("--workers", type=int, default=8, help="Number of data loader workers")
    parser.add_argument("--gpu-fraction", type=float, default=1.0, 
                        help="Fraction of GPU VRAM memory to limit this process to (0.0 to 1.0)")
    
    args = parser.parse_args()
    
    # 1. Ensure ultralytics is installed
    try:
        from ultralytics import YOLO
    except ImportError:
        print("[!] Ultralytics library not found. Please install it using:")
        print("    pip install ultralytics")
        sys.exit(1)
        
    # 2. Locate data.yaml
    script_dir = Path(__file__).parent.absolute()
    yaml_path = script_dir / "data.yaml"
    
    if not yaml_path.exists():
        print(f"[!] Could not find 'data.yaml' next to this script.")
        print(f"    Please place this script in the same directory as 'data.yaml'.")
        sys.exit(1)
        
    # 3. Create portable yaml
    portable_yaml = setup_portable_yaml(yaml_path)
    if not portable_yaml:
        sys.exit(1)
        
    # 4. Auto-detect best hardware accelerator if not specified
    device = args.device
    if not device:
        import torch
        if torch.cuda.is_available():
            device = "0"
            print("[i] Auto-detected NVIDIA GPU (CUDA).")
        elif torch.backends.mps.is_available():
            device = "mps"
            print("[i] Auto-detected Apple Silicon GPU (MPS).")
        else:
            device = "cpu"
            print("[i] Auto-detected CPU (Training will be slow).")
            
    # 5. Apply PyTorch GPU Memory Limit if requested
    if "cpu" not in str(device).lower() and "mps" not in str(device).lower():
        import torch
        if torch.cuda.is_available() and args.gpu_fraction < 1.0:
            try:
                # Convert device string (like '0' or '0,1') to integer index for the primary device
                device_idx = int(str(device).split(',')[0])
            except ValueError:
                device_idx = 0
            
            torch.cuda.set_per_process_memory_fraction(args.gpu_fraction, device=device_idx)
            print(f"[✓] GPU VRAM allocation limit set to {args.gpu_fraction * 100:.1f}% on device {device_idx}.")
            print("    * Note: This limits VRAM. If the model goes over this limit, it will raise an Out-of-Memory (OOM) exception.")

    print(f"\n[+] Initializing YOLO26 training:")
    print(f"    - Model variant: {args.model}")
    print(f"    - Epochs:        {args.epochs}")
    print(f"    - Image Size:    {args.imgsz}")
    print(f"    - Batch Size:    {args.batch}")
    print(f"    - Device:        {device}")
    print(f"    - Max GPU VRAM:  {args.gpu_fraction * 100:.1f}%")
    print("-" * 50)
    
    # 6. Load model and train
    model = YOLO(args.model)
    
    # MuSGD optimizer is the default/highly-recommended for YOLO26,
    # but we will let ultralytics choose the optimizer (or use 'auto').
    # We can explicitly try 'SGD' or let it auto-select.
    model.train(
        data=str(portable_yaml),
        epochs=100,
        batch=16,
        imgsz=640,
        device=device,
        workers=2,
        plots=True
    )
    
    print("\n[✓] Training complete! Results and weights saved in the 'runs/detect/train' directory.")

if __name__ == "__main__":
    main()

