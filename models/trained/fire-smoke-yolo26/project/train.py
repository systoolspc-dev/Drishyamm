from ultralytics import YOLO

def main():
    # Load the YOLOv12l model
    model = YOLO("yolo26m.pt")

    # Start training using the provided dataset configuration and hyperparameters
    model.train(
        data="data.yaml", 
        epochs=100,                
        patience=20,              # Stops if no improvement for 20 epochs
        imgsz=960,               
        batch=32,                 
        device=0,                 
        amp=True,                 
        dropout=0.3,
        project="runs",           
        name="fire_and_smoke_detection" ,
    )

if __name__ == "__main__":
    main()
