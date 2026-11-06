from ultralytics import YOLO

def main():
    # Load the YOLOv12l model
    model = YOLO("yolo26l.pt")

    # Start training using the provided dataset configuration and hyperparameters
    model.train(
        data="dataset/data.yaml", 
        epochs=100,                
        patience=20,              # Stops if no improvement for 20 epochs
        imgsz=960,               
        batch=16,                 
        device=0,                 
        amp=True,                 
        dropout=0.3,
        project="runs",           
        name="weapon_detection_v12l",
        workers=0,                # Disable multiprocessing workers (fixes Windows dataloader issues)
    )

if __name__ == "__main__":
    main()
